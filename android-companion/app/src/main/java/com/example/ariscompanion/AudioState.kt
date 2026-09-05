package com.example.ariscompanion

import kotlinx.coroutines.flow.MutableStateFlow

object AudioState {
    val isListening = MutableStateFlow(false)
    val currentAmplitude = MutableStateFlow(0f)
}
