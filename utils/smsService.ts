const SMS_API_URL = "http://bulksmsbd.net/api/smsapi";
const DEFAULT_API_KEY = "hS41YUabAzeqc9dnpk9f";
const DEFAULT_SENDER_ID = "Random";

export interface SMSResponse {
  success: boolean;
  code?: number;
  message?: string;
  sentTo?: string[];
  failedNumbers?: string[];
}

/**
 * Format phone number to Bangladesh format (880XXXXXXXXX)
 */
function formatPhoneNumber(num: string): string {
  // Remove spaces, dashes, and other characters
  let cleaned = num.replace(/[\s\-\(\)]/g, "");

  // Add country code if not present
  if (!cleaned.startsWith("880")) {
    // Remove leading 0 if present
    if (cleaned.startsWith("0")) {
      cleaned = cleaned.substring(1);
    }
    cleaned = `880${cleaned}`;
  }

  return cleaned;
}

/**
 * Send SMS to single or multiple recipients
 */
export async function sendSMS(
  mobileNumbers: string | string[],
  message: string,
  senderId: string = DEFAULT_SENDER_ID,
  apiKey: string = DEFAULT_API_KEY
): Promise<SMSResponse> {
  try {
    // Convert single number to array
    const numbers = Array.isArray(mobileNumbers)
      ? mobileNumbers
      : [mobileNumbers];

    // Format numbers (ensure they start with 880 for Bangladesh)
    const formattedNumbers = numbers.map(formatPhoneNumber);

    // Join numbers with comma for bulk SMS
    const numberString = formattedNumbers.join(",");

    // URL encode the message
    const encodedMessage = encodeURIComponent(message);

    // Build API URL
    const apiUrl = `${SMS_API_URL}?api_key=${apiKey}&type=text&number=${numberString}&senderid=${senderId}&message=${encodedMessage}`;

    // Send SMS using fetch
    const response = await fetch(apiUrl);

    // Get response text
    const responseText = await response.text();

    // Try to parse as JSON first
    let responseData: any;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // If not JSON, use the text as is
      responseData = responseText;
    }

    // Handle different response formats
    if (typeof responseData === "string") {
      // If response is a string, check for success indicators
      if (
        responseData.toLowerCase().includes("success") ||
        responseData.includes("202")
      ) {
        return {
          success: true,
          code: 202,
          message: "SMS Submitted Successfully",
          sentTo: formattedNumbers,
        };
      }
      // Check for error codes in string
      const errorMatch = responseData.match(/\d{4}/);
      if (errorMatch) {
        const errorCode = parseInt(errorMatch[0]);
        return {
          success: false,
          code: errorCode,
          message: getErrorMessage(errorCode),
        };
      }
    } else if (typeof responseData === "object") {
      // Response is already an object
      if (responseData.status === "success" || responseData.code === 202) {
        return {
          success: true,
          code: 202,
          message: responseData.message || "SMS Submitted Successfully",
          sentTo: formattedNumbers,
        };
      } else {
        // Error response
        const errorCode = responseData.code || responseData.error_code;
        const errorMessage = getErrorMessage(errorCode);

        return {
          success: false,
          code: errorCode,
          message: errorMessage,
        };
      }
    }

    // Default success if no error detected
    return {
      success: true,
      code: 202,
      message: "SMS Submitted Successfully",
      sentTo: formattedNumbers,
    };
  } catch (error) {
    console.error("SMS sending error:", error);

    return {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Unknown error occurred while sending SMS",
    };
  }
}

/**
 * Send multiple SMS with different messages (Many SMS API)
 */
export async function sendBulkSMS(
  messages: Array<{ number: string; message: string }>,
  senderId: string = DEFAULT_SENDER_ID,
  apiKey: string = DEFAULT_API_KEY
): Promise<SMSResponse> {
  try {
    // Format the messages according to Bulk SMS BD format
    // Format: number1|message1,number2|message2,...
    const formattedMessages = messages
      .map((msg) => {
        let cleaned = msg.number.replace(/[\s\-\(\)]/g, "");
        if (!cleaned.startsWith("880")) {
          if (cleaned.startsWith("0")) {
            cleaned = cleaned.substring(1);
          }
          cleaned = `880${cleaned}`;
        }

        // URL encode the message
        const encodedMessage = encodeURIComponent(msg.message);
        return `${cleaned}|${encodedMessage}`;
      })
      .join(",");

    const apiUrl = `${SMS_API_URL}?api_key=${apiKey}&type=text&senderid=${senderId}&messages=${formattedMessages}`;

    const response = await fetch(apiUrl);
    const responseText = await response.text();

    let responseData: any;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (
      typeof responseData === "object" &&
      (responseData.status === "success" || responseData.code === 202)
    ) {
      return {
        success: true,
        code: 202,
        message: "Bulk SMS Submitted Successfully",
        sentTo: messages.map((msg) => msg.number),
      };
    }

    return {
      success: true,
      code: 202,
      message: "Bulk SMS Submitted Successfully",
      sentTo: messages.map((msg) => msg.number),
    };
  } catch (error) {
    console.error("Bulk SMS sending error:", error);
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Failed to send bulk SMS",
    };
  }
}

/**
 * Get error message from error code
 */
function getErrorMessage(code?: number): string {
  const errorMessages: Record<number, string> = {
    1001: "Invalid Number",
    1002: "Sender ID not correct or disabled",
    1003: "Please provide all required fields",
    1005: "Internal Error",
    1006: "Balance Validity Not Available",
    1007: "Balance Insufficient",
    1011: "User ID not found",
    1012: "Masking SMS must be sent in Bengali",
    1013: "Sender ID has not found Gateway by API key",
    1014: "Sender Type Name not found using this sender by API key",
    1015: "Sender ID has not found Any Valid Gateway by API key",
    1016: "Sender Type Name Active Price Info not found by this sender ID",
    1017: "Sender Type Name Price Info not found by this sender ID",
    1018: "The Owner of this Account is disabled",
    1019: "The (sender type name) Price of this Account is disabled",
    1020: "The parent of this account is not found",
    1021: "The parent active (sender type name) price of this account is not found",
    1031: "Your Account Not Verified, Please Contact Administrator",
    1032: "IP Not whitelisted",
  };

  return errorMessages[code || 1005] || "Unknown error occurred";
}
