package com.example.vnccompanion.ui.main

import android.content.Context
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
import com.example.vnccompanion.theme.*

@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  val prefs = remember { context.getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE) }
  val keyboard = LocalSoftwareKeyboardController.current

  var urlInput by remember { mutableStateOf(prefs.getString("last_url", "http://10.0.2.2:8000") ?: "http://10.0.2.2:8000") }
  var urlError by remember { mutableStateOf(false) }

  // History stored most-recent-first
  val historyList = remember {
    mutableStateListOf<String>().apply {
      val saved = prefs.getStringSet("history_ordered", null)
      if (saved != null) {
        // Ordered list stored as indexed keys
        val ordered = (0 until saved.size)
          .mapNotNull { prefs.getString("history_item_$it", null) }
        addAll(ordered)
      } else {
        // Migrate legacy unordered set
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
    // Add to front of history (most-recent first)
    historyList.remove(trimmed)
    historyList.add(0, trimmed)
    if (historyList.size > 20) historyList.removeAt(historyList.size - 1)
    prefs.edit().putString("last_url", trimmed).apply()
    saveHistory()
    onItemClick(Console(trimmed))
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

    Spacer(modifier = Modifier.height(40.dp))

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

    Spacer(modifier = Modifier.height(36.dp))

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

      LazyColumn(modifier = Modifier.fillMaxWidth()) {
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
      Spacer(modifier = Modifier.height(24.dp))
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
    }

    Spacer(modifier = Modifier.height(24.dp))
  }
}
