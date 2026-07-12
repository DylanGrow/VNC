package com.example.vnccompanion

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

@Serializable data object Main : NavKey
@Serializable data class Console(val url: String) : NavKey
@Serializable data object Settings : NavKey
