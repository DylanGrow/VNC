package com.example.vnccompanion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.example.vnccompanion.data.ScreenCaptureService
import com.example.vnccompanion.theme.VNCCompanionTheme

class MainActivity : ComponentActivity() {

  private var activeServerUrl = ""

  private val projectionLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    if (result.resultCode == Activity.RESULT_OK && result.data != null) {
      val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
        action = ScreenCaptureService.ACTION_START
        putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
        putExtra(ScreenCaptureService.EXTRA_DATA_INTENT, result.data)
        putExtra(ScreenCaptureService.EXTRA_SERVER_URL, activeServerUrl)
      }
      ContextCompat.startForegroundService(this, serviceIntent)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    enableEdgeToEdge()
    setContent {
      VNCCompanionTheme { 
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { 
          MainNavigation() 
        } 
      }
    }
  }

  fun requestScreenCapture(serverUrl: String) {
    activeServerUrl = serverUrl
    val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
  }

  fun stopScreenCapture() {
    val serviceIntent = Intent(this, ScreenCaptureService::class.java).apply {
      action = ScreenCaptureService.ACTION_STOP
    }
    stopService(serviceIntent)
  }
}
