
const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "";
const WEB_APP_URL = process.env.WEB_APP_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const VIDEO_BOT_USERNAME = process.env.VIDEO_BOT_USERNAME || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

let db;
let firebaseReady = false;

const DEFAULT_SETTINGS = {
  appName: "Premium Video",
  appLogo: "",
  theme: "dark",

  promotionalChannel: {
    name: "Promotional Channel",
    url: ""
  },

  categories: [
    { id: "all", name: "All Videos", enabled: true },
    { id: "premium", name: "Premium", enabled: true },
    { id: "classic", name: "Classic", enabled: true }
  ],

  reward: {
    enabled: true,
    adsRequired: 50,
    rewardAmount: 1,
    rewardType: "credit"
  },

  referral: {
    enabled: true,
    rewardPerReferral: 1
  },

  ads: {
    activeNetwork: "monetag",
    monetagZoneId: "",
    gigapubZoneId: "",
    adsgramBlockId: "",
    adsPerVideo: 2
  },

  pagination: {
    videosPerPage: 10
  },

  maintenanceMode: false
};

function initializeFirebase() {
  if (firebaseReady) return;

  const serviceAccountJSON =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJSON || !DATABASE_URL) {
    console.error("Firebase environment variables missing");
    return;
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJSON);

    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DATABASE_URL
    });

    db = admin.database();
    firebaseReady = true;

    console.log("Firebase connected successfully");
  } catch (error) {
    console.error("Firebase initialization failed:", error.message);
  }
}

initializeFirebase();

function requireFirebase(req, res, next) {
  if (!firebaseReady) {
    return res.status(503).json({
      success: false,
      error: "Firebase not connected"
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key");

  if (!ADMIN_KEY || !key ||
      key.length !== ADMIN_KEY.length ||
      !crypto.timingSafeEqual(
        Buffer.from(key),
        Buffer.from(ADMIN_KEY)
      )) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  next();
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const a = Buffer.from(calculatedHash, "hex");
    const b = Buffer.from(hash, "hex");

    if (a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const authDate = Number(params.get("auth_date"));

    if (!authDate ||
        Date.now() / 1000 - authDate > 86400) {
      return null;
    }

    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function telegramRequest(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

async function saveTelegramUser(user, startParam = "") {
  if (!user || !user.id) return;

  const userRef = db.ref(`users/${user.id}`);
  const snapshot = await userRef.once("value");
  const oldUser = snapshot.val() || {};

  await userRef.update({
    telegramId: String(user.id),
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    username: user.username || "",
    languageCode: user.language_code || "",
    isPremium: !!user.is_premium,
    joinedAt: oldUser.joinedAt || Date.now(),
    lastActive: Date.now(),
    startParam: startParam || oldUser.startParam || "",
    blocked: false
  });
}

async function notifyAllUsers(video) {
  const snapshot = await db.ref("users").once("value");
  const users = snapshot.val() || {};

  const botUsername = VIDEO_BOT_USERNAME.replace(/^@/, "");
  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=v_${video.id}`
    : WEB_APP_URL;

  const message =
    `🎬 নতুন ভিডিও যোগ করা হয়েছে!\n\n` +
    `📌 ${video.title}\n\n` +
    `ভিডিও দেখতে নিচের বাটনে ক্লিক করুন।`;

  const ids = Object.keys(users);

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);

    await Promise.allSettled(
      batch.map(async (id) => {
        try {
          const buttons = deepLink
            ? [[{ text: "▶️ ভিডিও দেখুন", url: deepLink }]]
            : [];

          await telegramRequest("sendMessage", {
            chat_id: id,
            text: message,
            reply_markup: buttons.length
              ? { inline_keyboard: buttons }
              : undefined
          });
        } catch (error) {
          if (/blocked|chat not found|deactivated/i.test(error.message)) {
            await db.ref(`users/${id}`).update({
              blocked: true
            });
          }
        }
      })
    );
  }

  return ids.length;
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    firebase: firebaseReady,
    app: "Premium Video"
  });
});

// Public settings
app.get("/api/settings", requireFirebase, async (req, res) => {
  try {
    const snapshot = await db.ref("settings").once("value");
    const saved = snapshot.val() || {};

    res.json({
      success: true,
      settings: {
        ...DEFAULT_SETTINGS,
        ...saved,
        promotionalChannel: {
          ...DEFAULT_SETTINGS.promotionalChannel,
          ...(saved.promotionalChannel || {})
        },
        reward: {
          ...DEFAULT_SETTINGS.reward,
          ...(saved.reward || {})
        },
        referral: {
          ...DEFAULT_SETTINGS.referral,
          ...(saved.referral || {})
        },
        ads: {
          ...DEFAULT_SETTINGS.ads,
          ...(saved.ads || {})
        },
        pagination: {
          ...DEFAULT_SETTINGS.pagination,
          ...(saved.pagination || {})
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Public video listing
app.get("/api/videos", requireFirebase, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const category = String(req.query.category || "all");

    const snapshot = await db.ref("videos")
      .orderByChild("createdAt")
      .once("value");

    let videos = [];

    snapshot.forEach((child) => {
      const video = child.val();

      if (video && video.enabled !== false) {
        videos.push({
          id: child.key,
          ...video
        });
      }
    });

    videos.reverse();

    if (category !== "all") {
      videos = videos.filter(v => v.categoryId === category);
    }

    const perPage = 10;
    const total = videos.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;

    res.json({
      success: true,
      videos: videos.slice(start, start + perPage),
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Mini App user
app.get("/api/me", requireFirebase, async (req, res) => {
  const initData = req.get("x-telegram-init-data");
  const user = verifyTelegramInitData(initData);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Invalid Telegram session"
    });
  }

  try {
    await saveTelegramUser(user);

    const snapshot = await db.ref(`users/${user.id}`).once("value");

    res.json({
      success: true,
      user: snapshot.val()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: get dashboard information
app.get("/api/admin/dashboard",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      const [users, videos] = await Promise.all([
        db.ref("users").once("value"),
        db.ref("videos").once("value")
      ]);

      res.json({
        success: true,
        totalUsers: users.numChildren(),
        totalVideos: videos.numChildren()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: update settings
app.put("/api/admin/settings",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      const allowed = [
        "appName", "appLogo", "theme",
        "promotionalChannel", "categories",
        "reward", "referral", "ads",
        "pagination", "maintenanceMode"
      ];

      const updates = {};

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      await db.ref("settings").update(updates);

      res.json({
        success: true,
        message: "Settings updated"
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: add video
app.post("/api/admin/videos",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      const {
        title, description, thumbnail,
        videoUrl, categoryId, adsRequired
      } = req.body;

      if (!title || !thumbnail || !videoUrl) {
        return res.status(400).json({
          success: false,
          error: "Title, thumbnail and video URL are required"
        });
      }

      const videoRef = db.ref("videos").push();

      const video = {
        title: String(title).slice(0, 200),
        description: String(description || "").slice(0, 2000),
        thumbnail: String(thumbnail),
        videoUrl: String(videoUrl),
        categoryId: String(categoryId || "premium"),
        adsRequired: Math.max(1, Math.min(100, Number(adsRequired) || 2)),
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await videoRef.set(video);

      let notifiedUsers = 0;

      try {
        notifiedUsers = await notifyAllUsers({
          id: videoRef.key,
          ...video
        });
      } catch (error) {
        console.error("Notification error:", error.message);
      }

      res.json({
        success: true,
        videoId: videoRef.key,
        notifiedUsers,
        message: "Video added"
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: edit video
app.put("/api/admin/videos/:id",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      const ref = db.ref(`videos/${req.params.id}`);
      const snapshot = await ref.once("value");

      if (!snapshot.exists()) {
        return res.status(404).json({ error: "Video not found" });
      }

      const allowed = [
        "title", "description", "thumbnail",
        "videoUrl", "categoryId", "adsRequired", "enabled"
      ];

      const updates = { updatedAt: Date.now() };

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      await ref.update(updates);

      res.json({ success: true, message: "Video updated" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: delete video
app.delete("/api/admin/videos/:id",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      await db.ref(`videos/${req.params.id}`).remove();
      res.json({ success: true, message: "Video deleted" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: broadcast text or link
app.post("/api/admin/broadcast",
  requireFirebase, requireAdmin, async (req, res) => {
    try {
      const message = String(req.body.message || "").trim();

      if (!message || message.length > 4000) {
        return res.status(400).json({
          error: "Message is required (maximum 4000 characters)"
        });
      }

      const snapshot = await db.ref("users").once("value");
      const users = snapshot.val() || {};
      const ids = Object.keys(users);
      let sent = 0;
      let failed = 0;

      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);

        const results = await Promise.allSettled(
          batch.map(id =>
            telegramRequest("sendMessage", {
              chat_id: id,
              text: message,
              disable_web_page_preview: false
            })
          )
        );

        results.forEach(result => {
          if (result.status === "fulfilled") sent++;
          else failed++;
        });
      }

      res.json({
        success: true,
        total: ids.length,
        sent,
        failed
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Telegram webhook
app.post("/api/telegram/webhook", async (req, res) => {
  if (WEBHOOK_SECRET &&
      req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message || !message.from || !message.chat) return;
    if (!firebaseReady) return;

    const text = message.text || "";

    if (text.startsWith("/start")) {
      const payload = text.split(" ")[1] || "";

      await saveTelegramUser(message.from, payload);

      const keyboard = WEB_APP_URL
        ? {
            inline_keyboard: [[
              {
                text: "🎬 Open Premium Video",
                web_app: { url: WEB_APP_URL }
              }
            ]]
          }
        : undefined;

      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: "স্বাগতম Premium Video-তে! নিচের বাটনে Mini App খুলুন।",
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error("Webhook processing error:", error.message);
  }
});

// Set webhook after deployment
async function setupWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    console.log("Webhook setup skipped: environment variables missing");
    return;
  }

  try {
    const url = `${PUBLIC_URL.replace(/\/$/, "")}/api/telegram/webhook`;

    await telegramRequest("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"]
    });

    console.log("Telegram webhook configured");
  } catch (error) {
    console.error("Webhook setup failed:", error.message);
  }
}

app.get("/", (req, res) => {
  res.send("Premium Video Backend is running");
});

app.listen(PORT, () => {
  console.log(`Premium Video server running on port ${PORT}`);
  setupWebhook();
});
                                        
