package com.example.ariscompanion

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class ArisWidgetProvider : AppWidgetProvider() {
    companion object {
        const val ACTION_TICK = "com.example.ariscompanion.ARIS_WIDGET_TICK"
        private const val FRAME_COUNT = 4
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        widgetIds.forEach { widgetId ->
            updateWidget(context, manager, widgetId, 0)
        }
        scheduleTick(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_TICK) {
            val manager = AppWidgetManager.getInstance(context)
            manager.getAppWidgetIds(android.content.ComponentName(context, ArisWidgetProvider::class.java))
                .forEachIndexed { index, widgetId -> updateWidget(context, manager, widgetId, index % FRAME_COUNT) }
            scheduleTick(context)
        }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        if (appWidgetIds.isNotEmpty()) context.getSystemService(android.app.AlarmManager::class.java)
            ?.cancel(android.app.PendingIntent.getBroadcast(context, 0, Intent(ACTION_TICK).setPackage(context.packageName), android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT))
        super.onDeleted(context, appWidgetIds)
    }

    private fun updateWidget(context: Context, manager: AppWidgetManager, widgetId: Int, frame: Int) {
        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(context, widgetId, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val views = RemoteViews(context.packageName, R.layout.widget_aris).apply {
            setImageViewResource(R.id.aris_widget_character, characterFrames[frame])
            setOnClickPendingIntent(R.id.aris_widget_root, pendingIntent)
        }
        manager.updateAppWidget(widgetId, views)
    }

    private fun scheduleTick(context: Context) {
        val intent = Intent(ACTION_TICK).setPackage(context.packageName)
        val pending = PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        context.getSystemService(android.app.AlarmManager::class.java)?.setRepeating(
            android.app.AlarmManager.RTC,
            System.currentTimeMillis() + 900,
            900,
            pending,
        )
    }

    private val characterFrames = intArrayOf(
        R.drawable.widget_aris_character_1,
        R.drawable.widget_aris_character_2,
        R.drawable.widget_aris_character_3,
        R.drawable.widget_aris_character_2,
    )
}
