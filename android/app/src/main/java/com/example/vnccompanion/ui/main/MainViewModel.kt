package com.example.vnccompanion.ui.main

import android.content.Context
import android.content.SharedPreferences
import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class MainUiState(
  val urlInput: String = "http://10.0.2.2:8000",
  val urlError: Boolean = false,
  val isScanning: Boolean = false,
  val hasScanned: Boolean = false,
  val discoveredServers: List<String> = emptyList(),
  val historyList: List<String> = emptyList(),
)

class MainViewModel : ViewModel() {

  private val _uiState = MutableStateFlow(MainUiState())
  val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

  private lateinit var prefs: SharedPreferences

  fun init(context: Context) {
    if (::prefs.isInitialized) return
    prefs = context.getSharedPreferences("vnc_prefs", Context.MODE_PRIVATE)
    val savedUrl = prefs.getString("last_url", "http://10.0.2.2:8000") ?: "http://10.0.2.2:8000"
    val history = loadHistory()
    _uiState.update { it.copy(urlInput = savedUrl, historyList = history) }
  }

  private fun loadHistory(): List<String> {
    val saved = prefs.getStringSet("history_ordered", null)
    return if (saved != null) {
      (0 until saved.size).mapNotNull { prefs.getString("history_item_$it", null) }
    } else {
      (prefs.getStringSet("history", emptySet()) ?: emptySet()).toList()
    }
  }

  fun saveHistory(list: List<String>) {
    val editor = prefs.edit()
    editor.putStringSet("history_ordered", list.mapIndexed { i, _ -> i.toString() }.toSet())
    list.forEachIndexed { i, url -> editor.putString("history_item_$i", url) }
    editor.apply()
  }

  fun setUrl(url: String) {
    _uiState.update { it.copy(urlInput = url, urlError = false) }
  }

  fun setUrlError(error: Boolean) {
    _uiState.update { it.copy(urlError = error) }
  }

  fun addToHistory(url: String) {
    val mutable = _uiState.value.historyList.toMutableList()
    mutable.remove(url)
    mutable.add(0, url)
    if (mutable.size > 20) mutable.removeAt(mutable.size - 1)
    prefs.edit().putString("last_url", url).apply()
    saveHistory(mutable)
    _uiState.update { it.copy(historyList = mutable.toList()) }
  }

  fun removeFromHistory(url: String) {
    val mutable = _uiState.value.historyList.toMutableList()
    mutable.remove(url)
    saveHistory(mutable)
    _uiState.update { it.copy(historyList = mutable.toList()) }
  }

  fun clearHistory() {
    prefs.edit().remove("history_ordered").remove("history").apply()
    _uiState.update { it.copy(historyList = emptyList()) }
  }

  fun setScanState(scanning: Boolean) {
    _uiState.update { it.copy(isScanning = scanning, hasScanned = if (scanning) false else it.hasScanned) }
  }

  fun setDiscoveredServers(servers: List<String>) {
    _uiState.update { it.copy(discoveredServers = servers, hasScanned = true, isScanning = false) }
  }
}
