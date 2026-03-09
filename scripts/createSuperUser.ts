import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import User from "../modal/user";

// Load environment variables
dotenv.config();

interface SuperUserData {
  name: string;
  email: string;
  password: string;
}

const createSuperUser = async (): Promise<void> => {
  try {
    // Connect to database
    await connectDB();
    console.log("✅ Connected to database");

    // Get super user data from environment or use defaults
    const superUserData: SuperUserData = {
      name: process.env.SUPER_USER_NAME || "Admin",
      email: process.env.SUPER_USER_EMAIL || "admin@yunlaiporcelianartco.com",
      password: process.env.SUPER_USER_PASSWORD || "Admin@123",
    };

    // Check if user already exists
    const existingUser = await User.findOne({ email: superUserData.email });
    if (existingUser) {
      // Update password if provided
      if (superUserData.password) {
        existingUser.password = superUserData.password;
        await existingUser.save();
        console.log("✅ Existing user password updated");
        console.log(`   Email: ${existingUser.email}`);
      } else {
        console.log("ℹ️  User already exists");
        console.log(`   Email: ${existingUser.email}`);
      }
    } else {
      // Create new user
      const user = await User.create({
        name: superUserData.name,
        email: superUserData.email,
        password: superUserData.password,
      });

      console.log("✅ User created successfully!");
      console.log("========================================");
      console.log("User Details:");
      console.log("========================================");
      console.log(`Name: ${user.name}`);
      console.log(`Email: ${user.email}`);
      console.log(`Password: ${superUserData.password}`);
      console.log("========================================");
      console.log(
        "\n⚠️  IMPORTANT: Please change the password after first login!"
      );
      console.log("========================================\n");
    }

    // Close database connection
    await mongoose.connection.close();
    console.log("✅ Database connection closed");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating user:", error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the script
createSuperUser();
