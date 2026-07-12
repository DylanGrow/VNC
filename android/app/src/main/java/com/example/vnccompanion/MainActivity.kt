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
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat
import com.example.vnccompanion.data.ScreenCaptureService
import com.example.vnccompanion.theme.VNCCompanionTheme

class MainActivity : ComponentActivity() {

  private var activeServerUrl = ""

  // Whether the app is currently "locked" and waiting for biometric
  private var isLocked by mutableStateOf(false)
  private var biometricEnabled = false

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

    val prefs = getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE)
    biometricEnabled = prefs.getBoolean("biometric_lock", false)

    setContent {
      VNCCompanionTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          Box(modifier = Modifier.fillMaxSize()) {
            MainNavigation()
            // Dim overlay while locked
            AnimatedVisibility(
              visible = isLocked,
              enter = fadeIn(),
              exit = fadeOut(),
              modifier = Modifier.fillMaxSize()
            ) {
              Box(
                modifier = Modifier
                  .fillMaxSize()
                  .background(Color.Black)
              )
            }
          }
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    val prefs = getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE)
    biometricEnabled = prefs.getBoolean("biometric_lock", false)

    if (biometricEnabled) {
      val biometricManager = BiometricManager.from(this)
      val canAuthenticate = biometricManager.canAuthenticate(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
      if (canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS) {
        showBiometricPrompt()
      }
    }
  }

  private fun showBiometricPrompt() {
    isLocked = true
    val executor = ContextCompat.getMainExecutor(this)
    val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        super.onAuthenticationSucceeded(result)
        isLocked = false
      }
      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        super.onAuthenticationError(errorCode, errString)
        // On repeated failure or cancellation, close the app
        if (errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
          errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
          errorCode == BiometricPrompt.ERROR_LOCKOUT
        ) {
          finish()
        }
      }
      override fun onAuthenticationFailed() {
        super.onAuthenticationFailed()
        // Failed attempts handled by system; keep overlay visible
      }
    })

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
      .setTitle("ScreenConnect VNC")
      .setSubtitle("Authenticate to access your session")
      .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
      .build()

    prompt.authenticate(promptInfo)
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
