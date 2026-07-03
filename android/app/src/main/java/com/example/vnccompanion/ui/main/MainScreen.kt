package com.example.vnccompanion.ui.main

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation3.runtime.NavKey
import com.example.vnccompanion.Console
import com.example.vnccompanion.data.ScreenShareState
import com.example.vnccompanion.theme.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket

@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  val prefs = remember { context.getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE) }
  val keyboard = LocalSoftwareKeyboardController.current
  val coroutineScope = rememberCoroutineScope()

  var urlInput by remember { mutableStateOf(prefs.getString("last_url", "http://10.0.2.2:8000") ?: "http://10.0.2.2:8000") }
  var urlError by remember { mutableStateOf(false) }

  // Subnet auto-discovery states
  var isScanning by remember { mutableStateOf(false) }
  val discoveredServers = remember { mutableStateListOf<String>() }
  var hasScanned by remember { mutableStateOf(false) }

  // History stored most-recent-first
  val historyList = remember {
    mutableStateListOf<String>().apply {
      val saved = prefs.getStringSet("history_ordered", null)
      if (saved != null) {
        val ordered = (0 until saved.size)
          .mapNotNull { prefs.getString("history_item_$it", null) }
        addAll(ordered)
      } else {
        val legacy = prefs.getStringSet("history", emptySet()) ?: emptySet()
        addAll(legacy)
      }
    }
  }

  fun saveHistory() {
    val editor = prefs.edit()
    editor.putStringSet("history_ordered", historyList.mapIndexed { i, _ -> i.toString() }.toSet())
    historyList.forEachIndexed { i, url -> editor.putString("history_item_$i", url) }
    editor.apply()
  }

  fun connect(url: String) {
    val trimmed = url.trim()
    if (trimmed.isEmpty() || (!trimmed.startsWith("http://") && !trimmed.startsWith("https://"))) {
      urlError = true
      return
    }
    urlError = false
    keyboard?.hide()
    
    historyList.remove(trimmed)
    historyList.add(0, trimmed)
    if (historyList.size > 20) historyList.removeAt(historyList.size - 1)
    prefs.edit().putString("last_url", trimmed).apply()
    saveHistory()
    onItemClick(Console(trimmed))
  }

  // Network scanning utility methods
  fun getLocalIpAddress(): String? {
    try {
      val interfaces = NetworkInterface.getNetworkInterfaces()
      while (interfaces.hasMoreElements()) {
        val networkInterface = interfaces.nextElement()
        val addresses = networkInterface.inetAddresses
        while (addresses.hasMoreElements()) {
          val address = addresses.nextElement()
          if (!address.isLoopbackAddress && address is Inet4Address) {
            val ip = address.hostAddress
            if (ip != null && !ip.startsWith("127.")) {
              return ip
            }
          }
        }
      }
    } catch (ex: Exception) {
      ex.printStackTrace()
    }
    return null
  }

  fun checkIpPortOpen(ip: String, port: Int, timeout: Int): String? {
    var socket: Socket? = null
    try {
      socket = Socket()
      socket.connect(InetSocketAddress(ip, port), timeout)
      return "http://$ip:$port"
    } catch (e: Exception) {
      // Unreachable
    } finally {
      try {
        socket?.close()
      } catch (e: Exception) {
        // Ignored
      }
    }
    return null
  }

  fun runNetworkDiscovery() {
    coroutineScope.launch {
      isScanning = true
      hasScanned = true
      discoveredServers.clear()
      val localIp = getLocalIpAddress()
      if (localIp != null && localIp.contains(".")) {
        val subnetPrefix = localIp.substringBeforeLast(".") + "."
        val semaphore = Semaphore(40) // 40 concurrent scans
        val deferreds = (1..254).map { host ->
          val ip = "$subnetPrefix$host"
          async(Dispatchers.IO) {
            semaphore.withPermit {
              checkIpPortOpen(ip, 8000, timeout = 350)
            }
          }
        }
        val results = deferreds.awaitAll().filterNotNull()
        discoveredServers.addAll(results)
      } else {
        // Emulator / local fallback checks
        val fallbacks = listOf("10.0.2.2", "127.0.0.1")
        val deferreds = fallbacks.map { ip ->
          async(Dispatchers.IO) {
            checkIpPortOpen(ip, 8000, timeout = 350)
          }
        }
        val results = deferreds.awaitAll().filterNotNull()
        discoveredServers.addAll(results)
      }
      isScanning = false
    }
  }

  Column(
    modifier = modifier
      .fillMaxSize()
      .background(Slate900)
      .padding(horizontal = 24.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Spacer(modifier = Modifier.height(48.dp))

    // Logo mark
    Box(
      modifier = Modifier
        .size(72.dp)
        .clip(RoundedCornerShape(16.dp))
        .background(Sky600),
      contentAlignment = Alignment.Center
    ) {
      Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text("VNC", color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 22.sp)
        Text("SC", color = Sky400, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 3.sp)
      }
    }

    Spacer(modifier = Modifier.height(18.dp))

    Text("ScreenConnect Console", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
    Text("Android Companion", color = Slate400, fontSize = 12.sp, letterSpacing = 1.sp)

    Spacer(modifier = Modifier.height(30.dp))

    // URL Input
    OutlinedTextField(
      value = urlInput,
      onValueChange = { urlInput = it; urlError = false },
      label = { Text("Server URL") },
      placeholder = { Text("http://192.168.1.x:8000", color = Slate700) },
      singleLine = true,
      isError = urlError,
      supportingText = if (urlError) {
        { Text("Enter a valid URL starting with http:// or https://", color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
      } else null,
      trailingIcon = if (urlInput.isNotEmpty()) {
        { IconButton(onClick = { urlInput = "" }) { Icon(Icons.Default.Clear, contentDescription = "Clear", tint = Slate400) } }
      } else null,
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
      keyboardActions = KeyboardActions(onGo = { connect(urlInput) }),
      colors = OutlinedTextFieldDefaults.colors(
        focusedTextColor = Color.White,
        unfocusedTextColor = Color.White,
        focusedContainerColor = Slate800,
        unfocusedContainerColor = Slate800,
        focusedBorderColor = Sky600,
        unfocusedBorderColor = Slate700,
        focusedLabelColor = Sky400,
        unfocusedLabelColor = Slate400,
        errorBorderColor = MaterialTheme.colorScheme.error,
      ),
      modifier = Modifier.fillMaxWidth().animateContentSize()
    )

    Spacer(modifier = Modifier.height(14.dp))

    // Connect button
    Button(
      onClick = { connect(urlInput) },
      colors = ButtonDefaults.buttonColors(containerColor = Sky600),
      modifier = Modifier.fillMaxWidth().height(52.dp),
      shape = RoundedCornerShape(10.dp),
      elevation = ButtonDefaults.buttonElevation(defaultElevation = 4.dp)
    ) {
      Text("Connect to Session", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = 0.3.sp)
    }

    Spacer(modifier = Modifier.height(24.dp))

    // --- Subnet Auto-Discovery Section ---
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically
    ) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Icons.Default.Wifi, contentDescription = "Subnet Discovery", tint = Sky400, modifier = Modifier.size(16.dp))
        Text("Local Subnet Discovery", color = Slate400, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
      }
      IconButton(onClick = { runNetworkDiscovery() }, enabled = !isScanning, modifier = Modifier.size(32.dp)) {
        Icon(Icons.Default.Refresh, contentDescription = "Scan Subnet", tint = if (isScanning) Slate700 else Sky400, modifier = Modifier.size(16.dp))
      }
    }

    Spacer(modifier = Modifier.height(4.dp))

    if (isScanning) {
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(8.dp))
          .background(Slate800)
          .padding(16.dp),
        contentAlignment = Alignment.Center
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
          CircularProgressIndicator(color = Sky500, modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
          Text("Scanning local network subnet…", color = Slate300, fontSize = 11.sp)
        }
      }
    } else if (hasScanned) {
      if (discoveredServers.isNotEmpty()) {
        Card(
          colors = CardDefaults.cardColors(containerColor = Slate800),
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(8.dp)
        ) {
          Column(modifier = Modifier.padding(12.dp)) {
            discoveredServers.forEach { server ->
              Row(
                modifier = Modifier
                  .fillMaxWidth()
                  .clickable { urlInput = server }
                  .padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
              ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                  Box(
                    modifier = Modifier
                      .size(8.dp)
                      .clip(RoundedCornerShape(4.dp))
                      .background(Emerald500)
                  )
                  Text(server, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                }
                TextButton(
                  onClick = { connect(server) },
                  contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                  colors = ButtonDefaults.textButtonColors(contentColor = Sky400)
                ) {
                  Text("Quick Connect", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                }
              }
            }
          }
        }
      } else {
        Box(
          modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Slate800)
            .padding(12.dp),
          contentAlignment = Alignment.Center
        ) {
          Text("No active servers found on subnet.", color = Slate400, fontSize = 11.sp)
        }
      }
    }

    Spacer(modifier = Modifier.height(16.dp))

    // --- Screen Share Section ---
    val activity = context as? com.example.vnccompanion.MainActivity
    val isSharingScreen by ScreenShareState.isSharing

    Card(
      colors = CardDefaults.cardColors(containerColor = Slate800),
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(8.dp)
    ) {
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
      ) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
          Icon(
            imageVector = Icons.Default.Wifi,
            contentDescription = "Screen Share",
            tint = if (isSharingScreen) Emerald500 else Slate400,
            modifier = Modifier.size(20.dp)
          )
          Column {
            Text(
              text = "Share Phone Screen",
              color = Color.White,
              fontSize = 13.sp,
              fontWeight = FontWeight.Bold
            )
            Text(
              text = if (isSharingScreen) "Streaming live to VNC Server" else "Broadcast mobile viewport",
              color = if (isSharingScreen) Emerald500 else Slate400,
              fontSize = 10.sp
            )
          }
        }
        Switch(
          checked = isSharingScreen,
          onCheckedChange = { checked ->
            if (checked) {
              val trimmed = urlInput.trim()
              if (trimmed.isEmpty() || (!trimmed.startsWith("http://") && !trimmed.startsWith("https://"))) {
                urlError = true
              } else {
                urlError = false
                activity?.requestScreenCapture(trimmed)
              }
            } else {
              activity?.stopScreenCapture()
            }
          },
          colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White,
            checkedTrackColor = Sky600,
            uncheckedThumbColor = Slate400,
            uncheckedTrackColor = Slate900
          )
        )
      }
    }

    Spacer(modifier = Modifier.height(16.dp))

    // History section
    if (historyList.isNotEmpty()) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
      ) {
        Text("Recent Connections", color = Slate400, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
        TextButton(
          onClick = {
            historyList.clear()
            prefs.edit().remove("history_ordered").remove("history").apply()
          },
          contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
        ) {
          Text("Clear All", color = Slate400, fontSize = 11.sp)
        }
      }

      Spacer(modifier = Modifier.height(8.dp))

      LazyColumn(modifier = Modifier.fillMaxWidth().weight(1f)) {
        itemsIndexed(historyList, key = { _, item -> item }) { index, item ->
          Card(
            colors = CardDefaults.cardColors(containerColor = Slate800),
            modifier = Modifier
              .fillMaxWidth()
              .padding(vertical = 3.dp)
              .animateItem(),
            shape = RoundedCornerShape(8.dp),
          ) {
            Row(
              modifier = Modifier
                .fillMaxWidth()
                .clickable { urlInput = item }
                .padding(horizontal = 16.dp, vertical = 12.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Column(modifier = Modifier.weight(1f)) {
                Text(
                  text = item,
                  color = Color.White,
                  fontSize = 13.sp,
                  fontWeight = FontWeight.Medium,
                  maxLines = 1
                )
                if (index == 0) {
                  Text("Most Recent", color = Sky400, fontSize = 10.sp)
                }
              }
              Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(
                  onClick = { connect(item) },
                  contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)
                ) {
                  Text("Connect", color = Sky500, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
                IconButton(
                  onClick = {
                    historyList.removeAt(index)
                    saveHistory()
                  },
                  modifier = Modifier.size(32.dp)
                ) {
                  Icon(Icons.Default.Delete, contentDescription = "Remove", tint = Slate400, modifier = Modifier.size(16.dp))
                }
              }
            }
          }
        }
      }
    } else {
      // Empty state
      Spacer(modifier = Modifier.height(8.dp))
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(12.dp))
          .background(Slate800)
          .padding(32.dp),
        contentAlignment = Alignment.Center
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text("No Recent Sessions", color = Slate400, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
          Text("Enter a server URL above to get started", color = Slate700, fontSize = 11.sp)
        }
      }
      Spacer(modifier = Modifier.height(24.dp))
    }
  }
}
