package com.example.vnccompanion.ui.console

import android.annotation.SuppressLint
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ConsoleScreen(url: String, modifier: Modifier = Modifier) {
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
            // Grant microphone / media playback / WebRTC permissions automatically
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

        loadUrl(url)
      }
    },
    modifier = modifier.fillMaxSize()
  )
}
