package com.hubcast.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * NIP-55 bridge.
 *
 * Two transports, in order of preference:
 *
 *   1. Content Resolver — answers in the background with no UI at all. Only
 *      works for permissions the user ticked "remember my choice" on. This is
 *      the whole reason for going native: publishing a go-live event becomes
 *      instant instead of a context switch into Amber and back.
 *
 *   2. Intent — opens the signer for manual approval. Used for login, and as
 *      the fallback whenever the provider declines to answer.
 *
 * The distinction that matters: a null cursor means "not remembered, ask the
 * user", while a `rejected` column means "the user said never". Only the first
 * may fall back to an intent. Falling back on an explicit rejection would nag
 * the user with a popup they already refused.
 */
@CapacitorPlugin(name = "NostrSigner")
class NostrSignerPlugin : Plugin() {

    private data class ProviderResult(
        val result: String?,
        val event: String?,
        val rejected: Boolean
    )

    private fun signerIntent(payload: String = ""): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:$payload"))

    // -- discovery ---------------------------------------------------------

    @PluginMethod
    fun isInstalled(call: PluginCall) {
        val found = context.packageManager
            .queryIntentActivities(signerIntent(), 0)
            .isNotEmpty()
        call.resolve(JSObject().put("installed", found))
    }

    // -- login -------------------------------------------------------------

    /**
     * Always an intent: the spec says clients must not call get_public_key in
     * the background, and the user has to pick an account anyway.
     *
     * `permissions` is a JSON array string. Pre-authorising the kinds this app
     * publishes is what unlocks the background path later.
     */
    @PluginMethod
    fun getPublicKey(call: PluginCall) {
        val intent = signerIntent().apply {
            putExtra("type", "get_public_key")
            call.getString("permissions")?.let { putExtra("permissions", it) }
        }
        if (context.packageManager.queryIntentActivities(intent, 0).isEmpty()) {
            call.reject("NO_SIGNER", "No NIP-55 signer is installed.")
            return
        }
        startActivityForResult(call, intent, "onPublicKey")
    }

    @ActivityCallback
    private fun onPublicKey(call: PluginCall?, result: ActivityResult) {
        if (call == null) return

        // A non-OK code means the signer failed. Rejection is signalled with
        // RESULT_OK plus a `rejected` extra, which is a different thing.
        if (result.resultCode != Activity.RESULT_OK) {
            call.reject("SIGNER_ERROR", "The signer closed without answering.")
            return
        }
        val data = result.data
        if (data == null || isRejected(data)) {
            call.reject("REJECTED", "You declined the request.")
            return
        }
        val pubkey = data.getStringExtra("result")
        if (pubkey.isNullOrBlank()) {
            call.reject("SIGNER_ERROR", "The signer returned no public key.")
            return
        }
        call.resolve(
            JSObject()
                .put("pubkey", pubkey)
                // Every later request is addressed to this package, so the user
                // isn't offered a chooser again.
                .put("package", data.getStringExtra("package"))
        )
    }

    // -- signing -----------------------------------------------------------

    @PluginMethod
    fun signEvent(call: PluginCall) {
        val eventJson = call.getString("event")
        val currentUser = call.getString("currentUser")
        if (eventJson == null || currentUser == null) {
            call.reject("MISSING_PARAMS", "event and currentUser are both required.")
            return
        }
        val signerPackage = call.getString("package")
        val id = call.getString("id") ?: System.currentTimeMillis().toString()

        if (signerPackage != null) {
            val background = queryProvider(
                signerPackage, "SIGN_EVENT", arrayOf(eventJson, "", currentUser)
            )
            if (background != null) {
                if (background.rejected) {
                    call.reject("REJECTED", "You have blocked this request.")
                    return
                }
                if (background.event != null) {
                    call.resolve(
                        JSObject()
                            .put("event", background.event)
                            .put("signature", background.result)
                            .put("background", true)
                    )
                    return
                }
            }
        }

        // Not remembered yet — ask the user.
        val intent = signerIntent(eventJson).apply {
            signerPackage?.let { `package` = it }
            putExtra("type", "sign_event")
            putExtra("id", id)
            putExtra("current_user", currentUser)
        }
        startActivityForResult(call, intent, "onSignedEvent")
    }

    @ActivityCallback
    private fun onSignedEvent(call: PluginCall?, result: ActivityResult) {
        if (call == null) return

        if (result.resultCode != Activity.RESULT_OK) {
            call.reject("SIGNER_ERROR", "The signer closed without answering.")
            return
        }
        val data = result.data
        if (data == null || isRejected(data)) {
            call.reject("REJECTED", "You declined to sign.")
            return
        }
        val signedEvent = data.getStringExtra("event")
        if (signedEvent.isNullOrBlank()) {
            call.reject("SIGNER_ERROR", "The signer returned no event.")
            return
        }
        call.resolve(
            JSObject()
                .put("event", signedEvent)
                .put("signature", data.getStringExtra("result"))
                .put("background", false)
        )
    }

    // -- helpers -----------------------------------------------------------

    private fun isRejected(data: Intent): Boolean =
        data.getBooleanExtra("rejected", false) ||
            data.getStringExtra("rejected") == "true"

    /**
     * NIP-55 passes the payload in the *projection* argument, not
     * selectionArgs. That reads as a mistake but it is what every signer
     * implements, so it is the contract.
     *
     * Returns null when the provider declined to answer at all, which is the
     * signal to fall back to an intent.
     */
    private fun queryProvider(
        signerPackage: String,
        type: String,
        args: Array<String>
    ): ProviderResult? = try {
        context.contentResolver.query(
            Uri.parse("content://$signerPackage.$type"),
            args,
            null,
            null,
            null
        )?.use { cursor ->
            if (cursor.getColumnIndex("rejected") > -1) {
                ProviderResult(null, null, rejected = true)
            } else if (cursor.moveToFirst()) {
                val resultIdx = cursor.getColumnIndex("result")
                val eventIdx = cursor.getColumnIndex("event")
                ProviderResult(
                    result = if (resultIdx > -1) cursor.getString(resultIdx) else null,
                    event = if (eventIdx > -1) cursor.getString(eventIdx) else null,
                    rejected = false
                )
            } else {
                null
            }
        }
    } catch (e: Exception) {
        // Provider missing or permission denied. Treat as "ask the user".
        null
    }
}
