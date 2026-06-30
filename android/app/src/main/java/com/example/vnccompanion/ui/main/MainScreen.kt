package com.example.vnccompanion.ui.main

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation3.runtime.NavKey
import com.example.vnccompanion.Console

@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  val prefs = remember { context.getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE) }
  
  var urlInput by remember { mutableStateOf(prefs.getString("last_url", "http://10.0.2.2:8000") ?: "http://10.0.2.2:8000") }
  val historyList = remember { 
    mutableStateListOf<String>().apply {
      val savedList = prefs.getStringSet("history", emptySet()) ?: emptySet()
      addAll(savedList)
    }
  }

  Column(
    modifier = modifier
      .fillMaxSize()
      .background(Color(0xFF0F172A)) // Dark slate-900 background
      .padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally
  ) {
    Spacer(modifier = Modifier.height(32.dp))
    
    // ConnectWise logo / branding style
    Box(
      modifier = Modifier
        .size(64.dp)
        .clip(RoundedCornerShape(12.dp))
        .background(Color(0xFF0284C7)), // Brand sky-blue
      contentAlignment = Alignment.Center
    ) {
      Text(
        text = "VNC",
        color = Color.White,
        fontWeight = FontWeight.Bold,
        fontSize = 20.sp
      )
    }
    
    Spacer(modifier = Modifier.height(16.dp))
    
    Text(
      text = "ScreenConnect Console",
      color = Color.White,
      fontSize = 22.sp,
      fontWeight = FontWeight.Bold
    )
    
    Text(
      text = "Android Companion App",
      color = Color(0xFF94A3B8),
      fontSize = 12.sp
    )

    Spacer(modifier = Modifier.height(48.dp))

    OutlinedTextField(
      value = urlInput,
      onValueChange = { urlInput = it },
      label = { Text("Server URL", color = Color(0xFF64748B)) },
      singleLine = true,
      colors = TextFieldDefaults.colors(
        focusedTextColor = Color.White,
        unfocusedTextColor = Color.White,
        focusedContainerColor = Color(0xFF1E293B),
        unfocusedContainerColor = Color(0xFF1E293B),
        focusedIndicatorColor = Color(0xFF0284C7),
        unfocusedIndicatorColor = Color(0xFF334155)
      ),
      modifier = Modifier.fillMaxWidth()
    )

    Spacer(modifier = Modifier.height(16.dp))

    Button(
      onClick = {
        val finalUrl = urlInput.trim()
        if (finalUrl.isNotEmpty()) {
          // Save to history
          if (!historyList.contains(finalUrl)) {
            historyList.add(finalUrl)
            prefs.edit().putStringSet("history", historyList.toSet()).apply()
          }
          prefs.edit().putString("last_url", finalUrl).apply()
          onItemClick(Console(finalUrl))
        }
      },
      colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
      modifier = Modifier
        .fillMaxWidth()
        .height(50.dp),
      shape = RoundedCornerShape(8.dp)
    ) {
      Text(
        text = "Connect to Session",
        color = Color.White,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp
      )
    }

    Spacer(modifier = Modifier.height(32.dp))

    if (historyList.isNotEmpty()) {
      Text(
        text = "Recent Connections",
        color = Color(0xFF94A3B8),
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.align(Alignment.Start)
      )
      
      Spacer(modifier = Modifier.height(8.dp))
      
      LazyColumn(modifier = Modifier.fillMaxWidth()) {
        items(historyList) { item ->
          Card(
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
            modifier = Modifier
              .fillMaxWidth()
              .padding(vertical = 4.dp)
              .clickable { urlInput = item },
            shape = RoundedCornerShape(6.dp)
          ) {
            Row(
              modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically
            ) {
              Text(
                text = item,
                color = Color.White,
                fontSize = 13.sp
              )
              Text(
                text = "Tap to load",
                color = Color(0xFF0284C7),
                fontSize = 10.sp
              )
            }
          }
        }
      }
    }
  }
}
