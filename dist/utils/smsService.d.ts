export interface SMSResponse {
    success: boolean;
    code?: number;
    message?: string;
    sentTo?: string[];
    failedNumbers?: string[];
}
/**
 * Send SMS to single or multiple recipients
 */
export declare function sendSMS(mobileNumbers: string | string[], message: string, senderId?: string, apiKey?: string): Promise<SMSResponse>;
/**
 * Send multiple SMS with different messages (Many SMS API)
 */
export declare function sendBulkSMS(messages: Array<{
    number: string;
    message: string;
}>, senderId?: string, apiKey?: string): Promise<SMSResponse>;
//# sourceMappingURL=smsService.d.ts.map