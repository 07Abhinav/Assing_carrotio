const express = require('express');
const passport = require('passport');
const session = require('express-session');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { google } = require('googleapis');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const crypto = require('crypto');

dotenv.config();
const app = express();

// Connect to MongoDB
mongoose.connect("mongodb+srv://abhinav29072003:Legend100@cluster0.t0jdg.mongodb.net/carotio?retryWrites=true&w=majority", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// User Schema
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true },
  name: String,
  email: String,
  accessToken: String,
  refreshToken: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);

// Session Schema
const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
});

const Session = mongoose.model('Session', sessionSchema);

// Middleware
app.use(express.json());
const allowedOrigins = ['https://assing-carrotio.vercel.app'];

app.use(
  cors({
    origin: (origin, callback) => {
      if (allowedOrigins.includes(origin) || !origin) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Passport Setup
app.use(passport.initialize());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user || null);
  } catch (error) {
    done(error, null);
  }
});

// Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar.readonly'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });

        if (!user) {
          user = new User({
            googleId: profile.id,
            name: profile.displayName,
            email: profile.emails[0]?.value,
            accessToken,
            refreshToken,
          });
        } else {
          user.accessToken = accessToken;
          user.refreshToken = refreshToken;
          user.updatedAt = new Date();
        }

        await user.save();
        done(null, user);
      } catch (error) {
        done(error, null);
      }
    }
  )
);

// Custom Session Middleware
app.use(async (req, res, next) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    req.user = null;
    return next();
  }

  try {
    const session = await Session.findOne({ sessionId }).populate('userId');
    if (session && session.expiresAt > new Date()) {
      req.user = session.userId; // Attach the user object to the request
    } else {
      req.user = null;
    }
  } catch (error) {
    console.error('Session retrieval error:', error);
    req.user = null;
  }
  next();
});

// Calendar Service
const getCalendarEvents = async (accessToken, refreshToken, startDate, endDate) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startDate || new Date().toISOString(),
      timeMax: endDate,
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime',
    });

    return response.data.items;
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    throw error;
  }
};

// Routes
app.get('/auth/google', passport.authenticate('google'));

app.get(
  '/auth/google/callback',
  passport.authenticate('google', { session: false }),
  async (req, res) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = new Session({
      sessionId,
      userId: req.user._id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });
    await session.save();

    res.json({ sessionId, message: 'Login successful' });
  }
);

app.get('/api/calendar/events', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { startDate, endDate } = req.query;
    const events = await getCalendarEvents(
      req.user.accessToken,
      req.user.refreshToken,
      startDate,
      endDate
    );
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

app.post('/api/logout', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    await Session.deleteOne({ sessionId });
  }
  res.json({ message: 'Logged out' });
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
