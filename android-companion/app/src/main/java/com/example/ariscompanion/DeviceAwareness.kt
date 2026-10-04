package com.example.ariscompanion

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.service.notification.StatusBarNotification
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

object ConnectivityState {
    private val _isOnline = MutableStateFlow(true)
    val isOnline = _isOnline.asStateFlow()

    fun start(context: Context) {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        fun update() {
            val network = manager.activeNetwork
            val capabilities = manager.getNetworkCapabilities(network)
            _isOnline.value = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }
        update()
        manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = update()
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = update()
            override fun onLost(network: Network) = update()
        })
    }
}

object NotificationState {
    private val _notificationCount = MutableStateFlow(0)
    val notificationCount = _notificationCount.asStateFlow()

    private val _lastApp = MutableStateFlow<String?>(null)
    val lastApp = _lastApp.asStateFlow()

    private val _lastTitle = MutableStateFlow<String?>(null)
    val lastTitle = _lastTitle.asStateFlow()

    fun record(notification: StatusBarNotification) {
        _notificationCount.value += 1
        _lastApp.value = notification.packageName.substringAfterLast('.')
        _lastTitle.value = notification.notification.extras?.getCharSequence("android.title")?.toString()
    }

    fun clearAttention() {
        _notificationCount.value = 0
    }
}

class ArisNotificationListenerService : android.service.notification.NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        NotificationState.record(sbn)
        Log.d("ArisNotifications", "Notification observed from ${sbn.packageName}")
    }
}
