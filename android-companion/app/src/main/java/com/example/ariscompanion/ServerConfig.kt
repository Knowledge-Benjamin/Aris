package com.example.ariscompanion

import android.content.Context

object ServerConfig {
    const val PREFERENCES_NAME = "aris_chat_prefs"
    const val SERVER_URL_PREFERENCE = "server_url"
    const val DEFAULT_BASE_URL = "https://impose-persuaded-unjustly.ngrok-free.dev"

    fun normalizeBaseUrl(serverUrl: String): String =
        serverUrl.trim().trimEnd('/').ifEmpty { DEFAULT_BASE_URL }

    fun savedBaseUrl(context: Context): String =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .getString(SERVER_URL_PREFERENCE, null)
            ?.let(::normalizeBaseUrl)
            ?: DEFAULT_BASE_URL
}
