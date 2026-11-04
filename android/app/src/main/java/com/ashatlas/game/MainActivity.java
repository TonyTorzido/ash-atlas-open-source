package com.ashatlas.game;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeRuntimePlugin.class);
        registerPlugin(PurchasesPlugin.class);
        registerPlugin(StoreUpdatePlugin.class);
        registerPlugin(DeviceTrustPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
