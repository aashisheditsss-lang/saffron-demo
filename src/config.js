// All settings come from environment variables (see .env.example).
export function loadConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:8080').replace(/\/$/, ''); // Render sets RENDER_EXTERNAL_URL itself
  const config = {
    production: env.NODE_ENV === 'production',
    port: Number(env.PORT || 8080),
    publicUrl,
    menuUrl: env.MENU_URL || `${publicUrl}/menu`,     // customer menu page (frontend)
    trackUrl: env.TRACK_URL || `${publicUrl}/track`,  // customer tracking page (frontend)
    corsOrigin: env.CORS_ORIGIN || '*',
    dbFile: env.DB_FILE || 'data.db',
    secret: env.APP_SECRET || 'dev-only-secret',      // signs customer links
    staffToken: env.STAFF_TOKEN || 'dev-staff',       // kitchen / reception / owner screens
    missedCallSecret: env.MISSED_CALL_SECRET || '',
    wa: {
      token: env.WA_TOKEN || '',                 // Meta permanent access token
      phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
      appSecret: env.WA_APP_SECRET || '',        // verifies webhook signatures
      verifyToken: env.WA_VERIFY_TOKEN || 'dev-verify',
      updateTemplate: env.WA_UPDATE_TEMPLATE || '', // approved utility template with one {{1}} body param
      templateLang: env.WA_TEMPLATE_LANG || 'en',
      apiVersion: env.WA_API_VERSION || 'v21.0',
    },
    payments: { provider: env.PAYMENT_PROVIDER || 'mock' },
    // Optional: Supabase phone (OTP) login for customers who open the menu without WhatsApp.
    supabase: { url: (env.SUPABASE_URL || '').replace(/\/$/, ''), anonKey: env.SUPABASE_ANON_KEY || '' },
    shop: {
      name: env.SHOP_NAME || 'Saffron & Salt',
      whatsapp: (env.SHOP_WHATSAPP || '').replace(/\D/g, ''), // the restaurant's WhatsApp number, e.g. 971501234567 (for "Message us" links)
      lat: Number(env.SHOP_LAT || 25.1852),
      lng: Number(env.SHOP_LNG || 55.2721),
      // shortcut: a circle, not Dubai's real border. 50 km from Downtown reaches Jebel Ali/Dubai South but also
      // takes in Sharjah and Ajman, and misses Hatta. Use a boundary polygon if that matters.
      radiusKm: Number(env.DELIVERY_RADIUS_KM || 50),
      deliveryFee: Math.round(Number(env.DELIVERY_FEE_AED || 0) * 100), // fils; 0 = free delivery
      minOrder: Math.round(Number(env.MIN_ORDER_AED || 0) * 100),       // fils; 0 = no minimum
      open: env.OPEN_TIME || '10:00',
      close: env.CLOSE_TIME || '02:00',
      tz: 'Asia/Dubai',
      trn: env.TRN || '',
    },
  };
  if (config.production) {
    for (const [k, bad] of [['APP_SECRET', 'dev-only-secret'], ['STAFF_TOKEN', 'dev-staff']]) {
      if ((k === 'APP_SECRET' ? config.secret : config.staffToken) === bad) throw new Error(`Set ${k} before running in production.`);
    }
    if (!config.wa.appSecret) throw new Error('Set WA_APP_SECRET so WhatsApp webhooks can be verified.');
  }
  return config;
}
