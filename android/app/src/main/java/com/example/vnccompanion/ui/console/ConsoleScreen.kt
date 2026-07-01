package com.example.vnccompanion.ui.console

import android.annotation.SuppressLint
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ConsoleScreen(
  url: String,
  onBackClick: () -> Unit,
  modifier: Modifier = Modifier
) {
  var webViewRef: WebView? = null

  val sendShortcut: (List<String>) -> Unit = { keys ->
    val arrayJson = keys.joinToString(separator = ",", prefix = "[", postfix = "]") { "\"$it\"" }
    webViewRef?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('vnc-native-combo', { detail: $arrayJson }));",
      null
    )
  }

  Box(modifier = modifier.fillMaxSize().background(Color(0xFF0F172A))) {
    AndroidView(
      factory = { context ->
        WebView(context).apply {
          layoutParams = android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT
          )
          
          webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
              return false
            }
          }
          
          webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
              request.grant(request.resources)
            }
          }

          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
          }

          webViewRef = this
          loadUrl(url)
        }
      },
      modifier = Modifier.fillMaxSize().padding(bottom = 60.dp) // Leave space for shortcuts panel
    )

    // Floating Shortcuts Panel at the bottom
    Row(
      modifier = Modifier
        .align(Alignment.BottomCenter)
        .fillMaxWidth()
        .height(60.dp)
        .background(Color(0xFF1E293B)) // Slate-800
        .padding(horizontal = 8.dp, vertical = 8.dp)
        .horizontalScroll(rememberScrollState()),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
      Button(
        onClick = onBackClick,
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFDC2626)), // Red Disconnect
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Disconnect", fontSize = 12.sp, color = Color.White)
      }

      Button(
        onClick = { sendShortcut(listOf("ctrl", "alt", "delete")) },
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Ctrl+Alt+Del", fontSize = 12.sp, color = Color.White)
      }

      Button(
        onClick = { sendShortcut(listOf("alt", "tab")) },
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Alt+Tab", fontSize = 12.sp, color = Color.White)
      }

      Button(
        onClick = { sendShortcut(listOf("escape")) },
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Esc", fontSize = 12.sp, color = Color.White)
      }

      Button(
        onClick = { sendShortcut(listOf("tab")) },
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Tab", fontSize = 12.sp, color = Color.White)
      }

      Button(
        onClick = { sendShortcut(listOf("enter")) },
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
        shape = RoundedCornerShape(4.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        modifier = Modifier.height(36.dp)
      ) {
        Text("Enter", fontSize = 12.sp, color = Color.White)
      }
    }
  }
}
