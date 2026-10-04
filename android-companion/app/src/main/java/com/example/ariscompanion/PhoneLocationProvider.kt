package com.example.ariscompanion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.TimeZone
import kotlin.coroutines.resume

data class PhoneLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float?,
    val capturedAtEpochMs: Long,
)

object PhoneLocationProvider {
    private const val TAG = "PhoneLocation"
    private const val LOCATION_TIMEOUT_MS = 12_000L
    private const val MAX_CACHED_AGE_MS = 60_000L

    fun hasLocationPermission(context: Context): Boolean =
        hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)

    suspend fun currentLocation(context: Context): PhoneLocation? {
        if (!hasLocationPermission(context)) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val finePermission = hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
        val preferredProviders = if (finePermission) {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER)
        }

        val cached = lastKnownLocation(manager, preferredProviders)
        if (cached != null && System.currentTimeMillis() - cached.time in 0..MAX_CACHED_AGE_MS) {
            return cached.toPhoneLocation()
        }

        for (provider in preferredProviders) {
            if (!isProviderEnabled(manager, provider)) continue
            val fix = requestLocation(manager, provider)
            if (fix != null) return fix.toPhoneLocation()
        }
        return cached?.takeIf { System.currentTimeMillis() - it.time in 0..5 * 60 * 1000L }?.toPhoneLocation()
    }

    suspend fun uploadCurrentLocation(context: Context, serverUrl: String, token: String): Boolean {
        val location = currentLocation(context) ?: return false
        return withContext(Dispatchers.IO) {
            val baseUrl = ServerConfig.normalizeBaseUrl(serverUrl)
            val connection = (URL("$baseUrl/api/aris/location").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8_000
                readTimeout = 8_000
                doOutput = true
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Content-Type", "application/json")
            }

            try {
                val body = JSONObject()
                    .put("lat", location.latitude)
                    .put("lon", location.longitude)
                    .put("accuracyMeters", location.accuracyMeters)
                    .put("capturedAtEpochMs", location.capturedAtEpochMs)
                    .put("timezone", TimeZone.getDefault().id)
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                if (status !in 200..299) {
                    val errorBody = connection.errorStream?.bufferedReader()?.use { it.readText() }.orEmpty()
                    throw IOException("Location update failed with HTTP $status${if (errorBody.isBlank()) "" else ": $errorBody"}")
                }
                true
            } finally {
                connection.disconnect()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun lastKnownLocation(manager: LocationManager, providers: List<String>): Location? =
        providers.asSequence()
            .filter { isProviderEnabled(manager, it) }
            .mapNotNull { provider ->
                try {
                    manager.getLastKnownLocation(provider)
                } catch (securityException: SecurityException) {
                    Log.w(TAG, "Location permission changed while reading cached location", securityException)
                    null
                }
            }
            .maxByOrNull { it.time }

    @SuppressLint("MissingPermission")
    private suspend fun requestLocation(manager: LocationManager, provider: String): Location? =
        withTimeoutOrNull(LOCATION_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        completeLocationRequest(manager, this, continuation, location)
                    }

                    override fun onProviderDisabled(provider: String) {
                        completeLocationRequest(manager, this, continuation, null)
                    }

                    override fun onProviderEnabled(provider: String) = Unit

                    @Deprecated("Deprecated by Android")
                    override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit
                }
                continuation.invokeOnCancellation {
                    try {
                        manager.removeUpdates(listener)
                    } catch (securityException: SecurityException) {
                        Log.w(TAG, "Location permission changed while cancelling the location request", securityException)
                    }
                }
                try {
                    manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                } catch (securityException: SecurityException) {
                    Log.w(TAG, "Location permission changed while requesting a location fix", securityException)
                    completeLocationRequest(manager, listener, continuation, null)
                } catch (illegalArgumentException: IllegalArgumentException) {
                    completeLocationRequest(manager, listener, continuation, null)
                }
            }
        }

    private fun completeLocationRequest(
        manager: LocationManager,
        listener: LocationListener,
        continuation: kotlinx.coroutines.CancellableContinuation<Location?>,
        location: Location?,
    ) {
        try {
            manager.removeUpdates(listener)
        } catch (securityException: SecurityException) {
            Log.w(TAG, "Location permission changed while closing the location request", securityException)
        }
        if (continuation.isActive) continuation.resume(location)
    }

    private fun isProviderEnabled(manager: LocationManager, provider: String): Boolean =
        try {
            manager.isProviderEnabled(provider)
        } catch (_: IllegalArgumentException) {
            false
        }

    private fun hasPermission(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun Location.toPhoneLocation() =
        PhoneLocation(latitude, longitude, if (hasAccuracy()) accuracy else null, time)
}
