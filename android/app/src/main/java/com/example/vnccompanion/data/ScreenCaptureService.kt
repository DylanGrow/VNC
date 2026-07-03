package com.example.vnccompanion.data

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.compose.runtime.mutableStateOf
import androidx.core.app.NotificationCompat
import okhttp3.*
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

object ScreenShareState {
  val isSharing = mutableStateOf(false)
}

class ScreenCaptureService : Service() {

  companion object {
    private const val TAG = "ScreenCaptureService"
    private const val NOTIFICATION_ID = 8812
    private const val CHANNEL_ID = "vnc_screen_share_channel"
    
    const val ACTION_START = "ACTION_START"
    const val ACTION_STOP = "ACTION_STOP"
    const val EXTRA_RESULT_CODE = "EXTRA_RESULT_CODE"
    const val EXTRA_DATA_INTENT = "EXTRA_DATA_INTENT"
    const val EXTRA_SERVER_URL = "EXTRA_SERVER_URL"
  }

  private var mediaProjection: MediaProjection? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var handlerThread: HandlerThread? = null
  private var backgroundHandler: Handler? = null
  
  private var okHttpClient: OkHttpClient? = null
  private var webSocket: WebSocket? = null
  private var isConnecting = false

  private var lastFrameTime = 0L
  private val frameIntervalMs = 80L // ~12-15 FPS is optimal for mobile bandwidth

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    handlerThread = HandlerThread("VncScreenCapBackground").apply { start() }
    backgroundHandler = Handler(handlerThread!!.looper)
    okHttpClient = OkHttpClient.Builder().build()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) return START_NOT_STICKY

    when (intent.action) {
      ACTION_START -> {
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val dataIntent = intent.getParcelableExtra<Intent>(EXTRA_DATA_INTENT)
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: "http://10.0.2.2:8000"

        if (resultCode != 0 && dataIntent != null) {
          startScreenCapture(resultCode, dataIntent, serverUrl)
        } else {
          stopSelf()
        }
      }
      ACTION_STOP -> {
        stopScreenCapture()
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  private fun startScreenCapture(resultCode: Int, data: Intent, serverUrl: String) {
    Log.i(TAG, "Starting screen capture foreground service...")
    ScreenShareState.isSharing.value = true
    
    
    // Create persistent Notification
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("VNC Companion Screen Sharing")
      .setContentText("Actively streaming screen to VNC Server...")
      .setSmallIcon(android.R.drawable.ic_menu_share)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()

    // Start Foreground Service
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    // Connect WebSocket
    connectWebSocket(serverUrl)

    // Set up screen capture
    val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    windowManager.defaultDisplay.getRealMetrics(metrics)
    
    val width = minOf(metrics.widthPixels, 720) // Cap sharing width to 720px for optimal network encoding
    val scale = width.toFloat() / metrics.widthPixels.toFloat()
    val height = (metrics.heightPixels * scale).toInt()
    val density = metrics.densityDpi

    val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    mediaProjection = projectionManager.getMediaProjection(resultCode, data)

    imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
    
    @Suppress("DEPRECATION")
    virtualDisplay = mediaProjection?.createVirtualDisplay(
      "VNCDisplayMirror",
      width,
      height,
      density,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
      imageReader?.surface,
      null,
      backgroundHandler
    )

    imageReader?.setOnImageAvailableListener({ reader ->
      val now = System.currentTimeMillis()
      if (now - lastFrameTime < frameIntervalMs) {
        // Skip frame to respect capture interval throttling
        val img = reader.acquireLatestImage()
        img?.close()
        return@setOnImageAvailableListener
      }
      lastFrameTime = now

      val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
      try {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width

        // Reconstruct Bitmap accounting for rowPadding
        val bitmap = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(buffer)
        
        // Crop out the padding pixels
        val croppedBitmap = Bitmap.createBitmap(bitmap, 0, 0, width, height)
        bitmap.recycle()

        // Compress to JPEG
        val outStream = ByteArrayOutputStream()
        croppedBitmap.compress(Bitmap.CompressFormat.JPEG, 65, outStream)
        croppedBitmap.recycle()

        val jpegBytes = outStream.toByteArray()
        sendFrame(jpegBytes)
      } catch (e: Exception) {
        Log.e(TAG, "Error processing screen frame", e)
      } finally {
        image.close()
      }
    }, backgroundHandler)
  }

  private fun connectWebSocket(serverUrl: String) {
    if (isConnecting || webSocket != null) return
    isConnecting = true

    // Resolve ws/wss target endpoint from http/https server url
    val wsUrl = serverUrl.replace("http://", "ws://")
      .replace("https://", "wss://") + "/api/ws/publish-screen"

    Log.i(TAG, "Connecting publisher WebSocket to $wsUrl")
    val request = Request.Builder().url(wsUrl).build()

    webSocket = okHttpClient?.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.i(TAG, "WebSocket publisher connection successfully opened")
        isConnecting = false
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.e(TAG, "WebSocket publisher failure: ${t.message}")
        isConnecting = false
        this@ScreenCaptureService.webSocket = null
        // Reconnect after 3 seconds if capture is active
        if (mediaProjection != null) {
          backgroundHandler?.postDelayed({ connectWebSocket(serverUrl) }, 3000)
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.i(TAG, "WebSocket publisher closed")
        isConnecting = false
        this@ScreenCaptureService.webSocket = null
      }
    })
  }

  private fun sendFrame(bytes: ByteArray) {
    val ws = webSocket
    if (ws != null) {
      ws.send(bytes.toByteString())
    }
  }

  private fun stopScreenCapture() {
    Log.i(TAG, "Stopping screen capture...")
    ScreenShareState.isSharing.value = false
    webSocket?.close(1000, "Service stopped")
    webSocket = null

    virtualDisplay?.release()
    virtualDisplay = null

    imageReader?.setOnImageAvailableListener(null, null)
    imageReader?.close()
    imageReader = null

    mediaProjection?.stop()
    mediaProjection = null
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val serviceChannel = NotificationChannel(
        CHANNEL_ID,
        "Screen Capture Channel",
        NotificationManager.IMPORTANCE_LOW
      )
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(serviceChannel)
    }
  }

  override fun onDestroy() {
    stopScreenCapture()
    handlerThread?.quitSafely()
    super.onDestroy()
  }
}
