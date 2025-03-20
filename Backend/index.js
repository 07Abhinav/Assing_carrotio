const express = require('express');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();

// Connect to MongoDB
mongoose.connect("", {
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

// Middleware
app.use(express.json());
const allowedOrigins = ['https://assing-carrotio.vercel.app', 'http://localhost:3000'];

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

// Google OAuth2 Configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL
);

// Verify Access Token
const verifyAccessToken = async (accessToken) => {
  try {
    oauth2Client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    return data; // Contains user info (id, email, name, etc.)
  } catch (error) {
    console.error('Error verifying access token:', error);
    return null;
  }
};

// Generate OAuth2 URL
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});

// Handle Google OAuth2 Callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    let user = await User.findOne({ googleId: data.id });
    if (!user) {
      user = new User({
        googleId: data.id,
        name: data.name,
        email: data.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
      });
    } else {
      user.accessToken = tokens.access_token;
      user.refreshToken = tokens.refresh_token;
      user.updatedAt = new Date();
    }
    await user.save();
    const successRedirect = `${process.env.CLIENT_URL || 'https://assing-carrotio.vercel.app/dashboard'}?accessToken=${tokens.access_token}`;
    res.redirect(successRedirect);

  } catch (error) {
    console.error('Error during authentication:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Calendar Service
const getCalendarEvents = async (accessToken, startDate, endDate) => {
  try {
    oauth2Client.setCredentials({ access_token: accessToken });

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

// Protected Endpoint to Fetch Calendar Events
app.get('/api/calendar/events', async (req, res) => {
  const accessToken = req.headers['authorization']?.split(' ')[1];
  if (!accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const userInfo = await verifyAccessToken(accessToken);
    if (!userInfo) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    const { startDate, endDate } = req.query;
    const events = await getCalendarEvents(accessToken, startDate, endDate);
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// Logout Route (Optional)
app.post('/api/logout', (req, res) => {
  // Since the app is stateless, we simply inform the client to discard the token
  res.json({ message: 'Logged out' });
});

// Start Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
