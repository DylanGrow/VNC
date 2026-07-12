package com.example.vnccompanion.ui.settings

import android.content.Context
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
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
import com.example.vnccompanion.theme.*
import kotlin.math.roundToInt

@Composable
fun SettingsScreen(
  onBack: () -> Unit,
  modifier: Modifier = Modifier
) {
  val context = LocalContext.current
  val prefs = remember { context.getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE) }

  // --- Load persisted values ---
  var fps by remember { mutableFloatStateOf(prefs.getInt("screen_share_fps", 12).toFloat()) }
  var jpegQuality by remember { mutableFloatStateOf(prefs.getInt("screen_share_quality", 65).toFloat()) }
  var defaultPort by remember { mutableStateOf(prefs.getString("default_port", "8000") ?: "8000") }
  var biometricLock by remember { mutableStateOf(prefs.getBoolean("biometric_lock", false)) }
  var shortcutPreset by remember { mutableStateOf(prefs.getString("shortcut_preset", "Windows") ?: "Windows") }
  var saved by remember { mutableStateOf(false) }

  fun save() {
    prefs.edit()
      .putInt("screen_share_fps", fps.roundToInt())
      .putInt("screen_share_quality", jpegQuality.roundToInt())
      .putString("default_port", defaultPort)
      .putBoolean("biometric_lock", biometricLock)
      .putString("shortcut_preset", shortcutPreset)
      .apply()
    saved = true
  }

  Column(
    modifier = modifier
      .fillMaxSize()
      .background(Slate900)
  ) {
    // Top Bar
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .background(Slate800)
        .padding(horizontal = 8.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically
    ) {
      IconButton(onClick = onBack) {
        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = Color.White)
      }
      Spacer(Modifier.width(8.dp))
      Text("Settings", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
      Spacer(Modifier.weight(1f))
      AnimatedVisibility(visible = saved) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          modifier = Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(Emerald500.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 4.dp)
        ) {
          Icon(Icons.Default.Check, contentDescription = null, tint = Emerald500, modifier = Modifier.size(14.dp))
          Text("Saved", color = Emerald500, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
      }
    }

    Column(
      modifier = Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 16.dp),
      verticalArrangement = Arrangement.spacedBy(24.dp)
    ) {

      // --- Screen Share Section ---
      SettingsSection(title = "Screen Share") {
        // FPS Slider
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
          ) {
            Text("Frame Rate", color = Slate300, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(
              "${fps.roundToInt()} FPS",
              color = Sky400,
              fontSize = 13.sp,
              fontWeight = FontWeight.Bold
            )
          }
          Slider(
            value = fps,
            onValueChange = { fps = it; saved = false },
            onValueChangeFinished = { save() },
            valueRange = 5f..30f,
            steps = 24,
            colors = SliderDefaults.colors(
              thumbColor = Sky500,
              activeTrackColor = Sky600,
              inactiveTrackColor = Slate700
            )
          )
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("5 FPS (low bandwidth)", color = Slate700, fontSize = 10.sp)
            Text("30 FPS (high quality)", color = Slate700, fontSize = 10.sp)
          }
        }

        Spacer(Modifier.height(4.dp))

        // JPEG Quality Slider
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
          ) {
            Text("JPEG Quality", color = Slate300, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(
              "${jpegQuality.roundToInt()}%",
              color = Sky400,
              fontSize = 13.sp,
              fontWeight = FontWeight.Bold
            )
          }
          Slider(
            value = jpegQuality,
            onValueChange = { jpegQuality = it; saved = false },
            onValueChangeFinished = { save() },
            valueRange = 30f..95f,
            steps = 64,
            colors = SliderDefaults.colors(
              thumbColor = Sky500,
              activeTrackColor = Sky600,
              inactiveTrackColor = Slate700
            )
          )
          Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("30% (smallest)", color = Slate700, fontSize = 10.sp)
            Text("95% (sharpest)", color = Slate700, fontSize = 10.sp)
          }
        }
      }

      // --- Connection Section ---
      SettingsSection(title = "Connection") {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text("Default Port", color = Slate300, fontSize = 13.sp, fontWeight = FontWeight.Medium)
          OutlinedTextField(
            value = defaultPort,
            onValueChange = { defaultPort = it; saved = false },
            singleLine = true,
            placeholder = { Text("8000", color = Slate700) },
            colors = OutlinedTextFieldDefaults.colors(
              focusedTextColor = Color.White,
              unfocusedTextColor = Color.White,
              focusedContainerColor = Slate800,
              unfocusedContainerColor = Slate800,
              focusedBorderColor = Sky600,
              unfocusedBorderColor = Slate700,
            ),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(8.dp)
          )
        }
      }

      // --- Shortcuts Section ---
      SettingsSection(title = "Shortcut Preset") {
        val presets = listOf("Windows", "macOS", "Linux")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(
            "Optimises the shortcut ribbon for your target OS",
            color = Slate400,
            fontSize = 11.sp
          )
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
          ) {
            presets.forEach { preset ->
              val selected = shortcutPreset == preset
              Button(
                onClick = { shortcutPreset = preset; save() },
                colors = ButtonDefaults.buttonColors(
                  containerColor = if (selected) Sky600 else Slate800
                ),
                shape = RoundedCornerShape(8.dp),
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                modifier = Modifier.weight(1f)
              ) {
                Text(preset, color = Color.White, fontSize = 12.sp, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
              }
            }
          }
        }
      }

      // --- Security Section ---
      SettingsSection(title = "Security") {
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text("Biometric App Lock", color = Slate300, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(
              "Require fingerprint or face unlock when resuming",
              color = Slate400,
              fontSize = 11.sp
            )
          }
          Spacer(Modifier.width(16.dp))
          Switch(
            checked = biometricLock,
            onCheckedChange = { biometricLock = it; save() },
            colors = SwitchDefaults.colors(
              checkedThumbColor = Color.White,
              checkedTrackColor = Sky600,
              uncheckedThumbColor = Slate400,
              uncheckedTrackColor = Slate900
            )
          )
        }
      }

      // --- About Section ---
      SettingsSection(title = "About") {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("Version", color = Slate400, fontSize = 12.sp)
          Text("1.0.0", color = Slate300, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          Text("App", color = Slate400, fontSize = 12.sp)
          Text("ScreenConnect VNC Companion", color = Slate300, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
      }

      Spacer(Modifier.height(40.dp))
    }
  }
}

@Composable
private fun SettingsSection(
  title: String,
  content: @Composable ColumnScope.() -> Unit
) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text(
      text = title.uppercase(),
      color = Sky400,
      fontSize = 10.sp,
      fontWeight = FontWeight.ExtraBold,
      letterSpacing = 1.5.sp
    )
    Box(
      modifier = Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(12.dp))
        .background(Slate800)
        .padding(16.dp)
    ) {
      Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content
      )
    }
  }
}
