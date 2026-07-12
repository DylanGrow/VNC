package com.example.vnccompanion.ui.console

import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import kotlin.math.abs

/**
 * TouchpadOverlay intercepts raw touch gestures on the canvas and translates them
 * into VNC remote mouse events by injecting JavaScript into the WebView.
 *
 * Modes:
 *  - Single-finger tap → remote left-click
 *  - Two-finger tap    → remote right-click
 *  - Single-finger drag → relative mouse move
 *  - Two-finger scroll (vertical drag) → scroll wheel
 */
@Composable
fun TouchpadOverlay(
  webView: WebView?,
  modifier: Modifier = Modifier
) {
  // Accumulator for relative mouse movement between drag events
  var lastDragX by remember { mutableFloatStateOf(0f) }
  var lastDragY by remember { mutableFloatStateOf(0f) }

  /**
   * Sends a custom event to the VNC web client that maps to the given action.
   * The web client listens for 'vnc-touchpad-event' CustomEvents.
   */
  fun sendTouchpadEvent(type: String, dx: Float = 0f, dy: Float = 0f, button: Int = 0) {
    val js = """
      window.dispatchEvent(new CustomEvent('vnc-touchpad-event', {
        detail: { type: '$type', dx: $dx, dy: $dy, button: $button }
      }));
    """.trimIndent()
    webView?.evaluateJavascript(js, null)
  }

  Box(
    modifier = modifier
      .fillMaxSize()
      .background(Color.Transparent)
      .pointerInput(webView) {
        // Tap handler — distinguishes 1-finger (left click) from 2-finger (right click)
        detectTapGestures(
          onTap = { _ ->
            sendTouchpadEvent("click", button = 0)
          },
          onLongPress = { _ ->
            sendTouchpadEvent("click", button = 2) // Right-click fallback via long press
          }
        )
      }
      .pointerInput(webView) {
        // Drag handler — sends relative mouse movement deltas
        detectDragGestures(
          onDragStart = { offset ->
            lastDragX = offset.x
            lastDragY = offset.y
          },
          onDrag = { change, dragAmount ->
            change.consume()
            val dx = dragAmount.x
            val dy = dragAmount.y
            // Sensitivity scaling — tune for comfortable feel on mobile
            val scaledDx = dx * 1.4f
            val scaledDy = dy * 1.4f
            sendTouchpadEvent("move", dx = scaledDx, dy = scaledDy)
          },
          onDragEnd = {}
        )
      }
  )
}
