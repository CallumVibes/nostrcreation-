package com.hubcast.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must be registered before super.onCreate, or the web layer's
        // registerPlugin('NostrSigner') resolves to nothing.
        registerPlugin(NostrSignerPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
