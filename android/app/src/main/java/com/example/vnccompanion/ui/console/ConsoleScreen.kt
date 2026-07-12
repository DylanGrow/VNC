package com.example.vnccompanion.ui.console

import android.annotation.SuppressLint
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.example.vnccompanion.theme.*

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ConsoleScreen(
  url: String,
  onBackClick: () -> Unit,
  modifier: Modifier = Modifier
) {
  var webViewRef by remember { mutableStateOf<WebView?>(null) }
  var loadingProgress by remember { mutableStateOf(0) }
  var isLoading by remember { mutableStateOf(true) }
  var touchpadMode by remember { mutableStateOf(false) }
  var showRow2 by remember { mutableStateOf(false) }

  // Keep screen on during active VNC sessions
  val context = LocalContext.current
  DisposableEffect(Unit) {
    val activity = context as? android.app.Activity
    activity?.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    onDispose {
      activity?.window?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }

  BackHandler {
    if (webViewRef?.canGoBack() == true) {
      webViewRef?.goBack()
    } else {
      onBackClick()
    }
  }

  val sendShortcut: (List<String>) -> Unit = { keys ->
    val arrayJson = keys.joinToString(separator = ",", prefix = "[", postfix = "]") { "\"$it\"" }
    webViewRef?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('vnc-native-combo', { detail: $arrayJson }));",
      null
    )
  }

  Box(modifier = modifier.fillMaxSize().background(Color(0xFF0F172A))) {
    Column(modifier = Modifier.fillMaxSize()) {

      // Loading progress bar
      if (isLoading) {
        LinearProgressIndicator(
          progress = { loadingProgress / 100f },
          modifier = Modifier.fillMaxWidth().height(3.dp),
          color = Sky500,
          trackColor = Slate800
        )
      } else {
        Spacer(modifier = Modifier.height(3.dp))
      }

      // WebView fills main area
      Box(modifier = Modifier.weight(1f)) {
        AndroidView(
          factory = { ctx ->
            WebView(ctx).apply {
              layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
              )

              webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?) = false
                override fun onPageFinished(view: WebView?, url: String?) {
                  super.onPageFinished(view, url)
                  isLoading = false
                }
              }

              webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                  request.grant(request.resources)
                }
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                  super.onProgressChanged(view, newProgress)
                  loadingProgress = newProgress
                  if (newProgress >= 100) isLoading = false
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
          modifier = Modifier.fillMaxSize()
        )

        // Touchpad overlay sits above WebView when active
        AnimatedVisibility(
          visible = touchpadMode,
          enter = fadeIn(),
          exit = fadeOut(),
          modifier = Modifier.fillMaxSize()
        ) {
          TouchpadOverlay(webView = webViewRef, modifier = Modifier.fillMaxSize())
        }

        // Touchpad mode indicator badge
        AnimatedVisibility(
          visible = touchpadMode,
          enter = fadeIn(),
          exit = fadeOut(),
          modifier = Modifier.align(Alignment.TopEnd).padding(10.dp)
        ) {
          Row(
            modifier = Modifier
              .background(Sky600.copy(alpha = 0.90f), RoundedCornerShape(20.dp))
              .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
          ) {
            Icon(
              Icons.Default.TouchApp,
              contentDescription = null,
              tint = Color.White,
              modifier = Modifier.size(13.dp)
            )
            Text("Touchpad", color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      //  Shortcut Ribbon — Row 1 (always visible) + Row 2 (toggled)
      // ─────────────────────────────────────────────────────────────
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .background(Slate800)
      ) {
        // Row 1
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .padding(horizontal = 6.dp, vertical = 7.dp)
            .horizontalScroll(rememberScrollState()),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
          // Disconnect — red
          ShortcutButton(
            label = "✕ Back",
            color = Rose600,
            onClick = {
              if (webViewRef?.canGoBack() == true) webViewRef?.goBack() else onBackClick()
            }
          )

          // Touchpad toggle — glows sky when active
          ShortcutButton(
            label = if (touchpadMode) "🖱 Touch ON" else "🖱 Touch",
            color = if (touchpadMode) Sky600 else Slate700,
            onClick = { touchpadMode = !touchpadMode }
          )

          // More row toggle
          ShortcutButton(
            label = if (showRow2) "▲ Less" else "▼ More",
            color = Slate700,
            onClick = { showRow2 = !showRow2 }
          )

          ShortcutButton("Ctrl+Alt+Del", Sky600) { sendShortcut(listOf("ctrl", "alt", "delete")) }
          ShortcutButton("Win+D", Sky600) { sendShortcut(listOf("super", "d")) }
          ShortcutButton("Win+L", Sky600) { sendShortcut(listOf("super", "l")) }
          ShortcutButton("Alt+Tab", Sky600) { sendShortcut(listOf("alt", "tab")) }
          ShortcutButton("Ctrl+A", Sky600) { sendShortcut(listOf("ctrl", "a")) }
          ShortcutButton("Ctrl+C", Sky600) { sendShortcut(listOf("ctrl", "c")) }
          ShortcutButton("Ctrl+V", Sky600) { sendShortcut(listOf("ctrl", "v")) }
          ShortcutButton("Ctrl+Z", Sky600) { sendShortcut(listOf("ctrl", "z")) }
          ShortcutButton("Esc", Sky600) { sendShortcut(listOf("escape")) }
          ShortcutButton("Enter", Sky600) { sendShortcut(listOf("enter")) }
          ShortcutButton("Tab", Sky600) { sendShortcut(listOf("tab")) }
        }

        // Row 2 — Function keys + navigation
        AnimatedVisibility(visible = showRow2) {
          Row(
            modifier = Modifier
              .fillMaxWidth()
              .height(46.dp)
              .padding(horizontal = 6.dp, vertical = 5.dp)
              .horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
          ) {
            ShortcutButton("F1", Slate700) { sendShortcut(listOf("f1")) }
            ShortcutButton("F2", Slate700) { sendShortcut(listOf("f2")) }
            ShortcutButton("F3", Slate700) { sendShortcut(listOf("f3")) }
            ShortcutButton("F4", Slate700) { sendShortcut(listOf("f4")) }
            ShortcutButton("F5", Slate700) { sendShortcut(listOf("f5")) }
            ShortcutButton("F11", Slate700) { sendShortcut(listOf("f11")) }
            ShortcutButton("PrintScr", Slate700) { sendShortcut(listOf("print_screen")) }
            ShortcutButton("Home", Slate700) { sendShortcut(listOf("home")) }
            ShortcutButton("End", Slate700) { sendShortcut(listOf("end")) }
            ShortcutButton("PgUp", Slate700) { sendShortcut(listOf("page_up")) }
            ShortcutButton("PgDn", Slate700) { sendShortcut(listOf("page_down")) }
            ShortcutButton("Del", Slate700) { sendShortcut(listOf("delete")) }
            ShortcutButton("Ctrl+Shift+Esc", Rose600) { sendShortcut(listOf("ctrl", "shift", "escape")) }
            ShortcutButton("Win+E", Sky600) { sendShortcut(listOf("super", "e")) }
            ShortcutButton("Win+R", Sky600) { sendShortcut(listOf("super", "r")) }
          }
        }
      }
    }
  }
}

@Composable
private fun ShortcutButton(
  label: String,
  color: Color,
  onClick: () -> Unit
) {
  Button(
    onClick = onClick,
    colors = ButtonDefaults.buttonColors(containerColor = color),
    shape = RoundedCornerShape(6.dp),
    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
    modifier = Modifier.height(36.dp)
  ) {
    Text(label, fontSize = 11.sp, color = Color.White, fontWeight = FontWeight.SemiBold, maxLines = 1)
  }
}
