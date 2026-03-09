# Create Super User Script

This script creates a super user (admin) with full access to all features in the coaching center application.

## Usage

### Method 1: Using npm script (Recommended)

```bash
cd backend
npm run create-super-user
```

### Method 2: Using ts-node directly

```bash
cd backend
npx ts-node scripts/createSuperUser.ts
```

## Configuration

You can configure the super user credentials using environment variables in your `.env` file:

```env
SUPER_USER_NAME=Super Admin
SUPER_USER_EMAIL=admin@coachingcenter.com
SUPER_USER_PASSWORD=Admin@123
```

If these environment variables are not set, the script will use the default values:

- **Name**: "Super Admin"
- **Email**: "admin@coachingcenter.com"
- **Password**: "Admin@123"

## What the Script Does

1. Connects to the MongoDB database
2. Checks if a user with the specified email already exists
3. If the user exists:
   - Updates the user to admin role if not already admin
   - Updates password if provided
4. If the user doesn't exist:
   - Creates a new user with:
     - Role: `admin`
     - User Type: `main-user`
     - Email verified: `true`
     - All permissions (admin role grants all access)

## Important Notes

⚠️ **Security Warning**:

- Change the default password after first login
- Use strong passwords in production
- Keep your `.env` file secure and never commit it to version control

## After Creating Super User

1. Login with the super user credentials
2. Navigate to `/settings` page
3. You can now create and manage sub-users
4. Change the password to a secure one
