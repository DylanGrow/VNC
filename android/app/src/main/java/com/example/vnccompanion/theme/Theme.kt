package com.example.vnccompanion.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Always use the branded dark scheme — no dynamic color, no light mode
private val BrandedDarkColorScheme = darkColorScheme(
  primary          = Sky600,
  onPrimary        = Color.White,
  primaryContainer = Slate800,
  secondary        = Sky400,
  onSecondary      = Slate900,
  background       = Slate900,
  onBackground     = Slate300,
  surface          = Slate800,
  onSurface        = Slate300,
  surfaceVariant   = Slate700,
  onSurfaceVariant = Slate400,
  outline          = Slate700,
  error            = Rose600,
  onError          = Color.White,
)

@Composable
fun VNCCompanionTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = BrandedDarkColorScheme,
    typography  = Typography,
    content     = content
  )
}
