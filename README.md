# Coaching Center Backend API

A Node.js, Express.js, and TypeScript backend API with authentication system.

## Features

- ✅ User authentication (Sign up, Sign in)
- ✅ Social login (Google, Facebook, GitHub)
- ✅ JWT access tokens and refresh tokens
- ✅ Password hashing with bcrypt
- ✅ MongoDB database with Mongoose
- ✅ TypeScript for type safety
- ✅ Protected routes with authentication middleware

## Environment Variables

Create a `.env` file in the backend directory with the following variables:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Database Configuration
MONGODB_URI=mongodb://localhost:27017/coaching-center
# Or for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/coaching-center?retryWrites=true&w=majority

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-in-production
JWT_EXPIRE=15m
JWT_REFRESH_EXPIRE=7d
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with the variables above

3. Start development server:
```bash
npm run dev
```

## API Endpoints

### Authentication Routes (`/api/auth`)

#### Public Routes

- `POST /api/auth/register` - Sign up with credentials
  ```json
  {
    "name": "John Doe",
    "email": "john@example.com",
    "password": "password123",
    "role": "student" // optional: "student" | "teacher" | "admin"
  }
  ```

- `POST /api/auth/login` - Sign in with credentials
  ```json
  {
    "email": "john@example.com",
    "password": "password123"
  }
  ```

- `POST /api/auth/signin/social` - Sign in with social provider
  ```json
  {
    "provider": "google", // "google" | "facebook" | "github"
    "providerId": "123456789",
    "email": "john@example.com",
    "name": "John Doe",
    "avatar": "https://example.com/avatar.jpg" // optional
  }
  ```

- `POST /api/auth/refresh` - Refresh access token
  ```json
  {
    "refreshToken": "your-refresh-token"
  }
  ```

#### Protected Routes (Require Bearer Token)

- `GET /api/auth/me` - Get current user
  - Headers: `Authorization: Bearer <accessToken>`

- `POST /api/auth/logout` - Sign out (clears refresh token)
  - Headers: `Authorization: Bearer <accessToken>`

## Response Format

### Success Response
```json
{
  "success": true,
  "message": "Operation successful",
  "user": { ... },
  "accessToken": "...",
  "refreshToken": "..."
}
```

### Error Response
```json
{
  "success": false,
  "message": "Error message"
}
```

## Project Structure

```
backend/
├── config/
│   ├── db.ts          # Database connection
│   └── jwt.ts         # JWT utilities
├── controller/
│   └── authController.ts  # Auth business logic
├── middleware/
│   └── auth.ts        # Authentication middleware
├── modal/
│   └── user.ts        # User model/schema
├── routes/
│   └── auth.ts        # Auth routes
├── server.ts          # Express app setup
└── package.json
```

## Development

- `npm run dev` - Start development server with nodemon
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run type-check` - Type check without building

