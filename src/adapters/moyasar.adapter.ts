// file: packages/subscriptions/src/adapters/moyasar.adapter.ts
// Moyasar payment gateway adapter for subscriptions package
// NOTE: Moyasar does NOT support native subscriptions - we use token-based recurring payments

import type {
  ChargePaymentInput,
  ChargePaymentResult,
  GatewayPayment,
  GatewayPaymentMethod,
  PaymentGatewayAdapter,
  WebhookEvent,
} from "./payment.adapter.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface MoyasarConfig {
  /** Secret API key (sk_live_xxx or sk_test_xxx) */
  secretKey: string;
  /** Publishable API key for frontend (pk_live_xxx or pk_test_xxx) */
  publishableKey: string;
  /** Shared secret configured on the Moyasar endpoint, sent as body secret_token. */
  webhookSecret?: string;
  /** Expected account name, if configured. Each account needs its own webhook endpoint/secret. */
  accountName?: string;
  /** Expected mode. Defaults to the mode indicated by sk_test_/sk_live_. */
  environment?: "test" | "live";
  /** Default callback URL after 3DS verification */
  callbackUrl: string;
  /** API base URL (defaults to production) */
  apiUrl?: string;
}

/** Moyasar payment status */
export type MoyasarPaymentStatus =
  | "initiated"
  | "paid"
  | "failed"
  | "authorized"
  | "captured"
  | "refunded"
  | "voided"
  | "verified";

/** Moyasar token status */
export type MoyasarTokenStatus = "initiated" | "active" | "inactive";

/** Response from Moyasar payments API */
export interface MoyasarPayment {
  id: string;
  status: MoyasarPaymentStatus;
  amount: number;
  fee: number;
  currency: string;
  refunded: number;
  captured: number;
  description?: string;
  callback_url?: string;
  invoice_id?: string;
  ip?: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, string>;
  source: {
    type: string;
    token?: string;
    transaction_url?: string;
    message?: string;
    gateway_id?: string;
    response_code?: string;
    name?: string;
    last_four?: string;
    brand?: string;
  };
}

/** Response from Moyasar tokens API */
export interface MoyasarToken {
  id: string;
  status: MoyasarTokenStatus;
  brand: string;
  funding: string;
  country: string;
  month: string;
  year: string;
  name: string;
  last_four: string;
  verification_url?: string;
  metadata?: Record<string, string>;
  message?: string;
  created_at: string;
  updated_at: string;
}

/** Moyasar webhook payload */
export interface MoyasarWebhookPayload {
  id: string;
  type: string;
  secret_token: string;
  account_name: string;
  live: boolean;
  data: MoyasarPayment;
  created_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Moyasar Error Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Moyasar API error types */
export type MoyasarErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_connection_error"
  | "account_inactive_error"
  | "api_error"
  | "3ds_auth_error";

/** HTTP status codes used by Moyasar */
export type MoyasarHttpStatus =
  | 200
  | 400
  | 401
  | 403
  | 404
  | 405
  | 429
  | 500
  | 503;

/** Gateway response codes (2-digit codes from acquirer) */
export type MoyasarGatewayResponseCode =
  | "00"
  | "01"
  | "02"
  | "03"
  | "04"
  | "05"
  | "06"
  | "07"
  | "08"
  | "09"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "19"
  | "21"
  | "22"
  | "23"
  | "25"
  | "30"
  | "31"
  | "33"
  | "34"
  | "35"
  | "36"
  | "37"
  | "38"
  | "39"
  | "40"
  | "41"
  | "42"
  | "43"
  | "44"
  | "51"
  | "52"
  | "53"
  | "54"
  | "55"
  | "56"
  | "57"
  | "59"
  | "60"
  | "61"
  | "62"
  | "63"
  | "64"
  | "65"
  | "66"
  | "67"
  | "75"
  | "79"
  | "82"
  | "90"
  | "91"
  | "92"
  | "93"
  | "94"
  | "96";

/** Error response from Moyasar API */
export interface MoyasarErrorResponse {
  type: MoyasarErrorType;
  message: string | null;
  errors?: Record<string, string[]>;
}

/** Payment declined error codes and their descriptions */
export interface PaymentErrorInfo {
  code: string;
  message: string;
  isRetryable: boolean;
  userAction:
    | "use_different_card"
    | "retry_later"
    | "contact_bank"
    | "check_details"
    | "none";
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════════════════════════════

class MoyasarClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: MoyasarConfig) {
    this.baseUrl = config.apiUrl ?? "https://api.moyasar.com/v1";
    // Moyasar uses Basic Auth with secret key
    this.authHeader = `Basic ${btoa(`${config.secretKey}:`)}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader,
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Network error (DNS, connection refused, etc.)
      throw new MoyasarAdapterError(
        error instanceof Error ? error.message : "Network error",
        "network_error",
        "NETWORK_ERROR",
        undefined,
        "Unable to connect to payment service",
        true,
        "retry_later",
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // Non-JSON response (rare, but handle it)
      if (!response.ok) {
        throw MoyasarAdapterError.fromHttpResponse(response.status);
      }
      throw new MoyasarAdapterError(
        "Invalid response from payment service",
        "api_error",
        "INVALID_RESPONSE",
        response.status,
        "Invalid response from payment service",
        true,
        "retry_later",
      );
    }

    if (!response.ok) {
      throw MoyasarAdapterError.fromHttpResponse(
        response.status,
        data as MoyasarErrorResponse,
      );
    }

    return data as T;
  }

  // Payments
  async createPayment(params: {
    amount: number;
    currency: string;
    description?: string;
    callbackUrl: string;
    source:
      | { type: "token"; token: string }
      | { type: "creditcard"; [key: string]: unknown };
    metadata?: Record<string, string>;
    givenId: string;
  }): Promise<MoyasarPayment> {
    return validatePayment(await this.request<unknown>("POST", "/payments", {
      given_id: params.givenId,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      callback_url: params.callbackUrl,
      source: params.source,
      metadata: params.metadata,
    }));
  }

  async getPayment(id: string): Promise<MoyasarPayment> {
    return validatePayment(await this.request<unknown>("GET", `/payments/${encodeURIComponent(id)}`));
  }

  async capturePayment(id: string, amount?: number): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>("POST", `/payments/${id}/capture`, {
      ...(amount && { amount }),
    });
  }

  async voidPayment(id: string): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>("POST", `/payments/${id}/void`);
  }

  // Tokens
  async getToken(id: string): Promise<MoyasarToken> {
    return validateToken(await this.request<unknown>("GET", `/tokens/${encodeURIComponent(id)}`));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Mappings
// ═══════════════════════════════════════════════════════════════════════════════

/** Map of gateway response codes to error info */
const GATEWAY_RESPONSE_CODES: Record<string, PaymentErrorInfo> = {
  "00": {
    code: "00",
    message: "Transaction Approved",
    isRetryable: false,
    userAction: "none",
  },
  "01": {
    code: "01",
    message: "Card issue - contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "02": {
    code: "02",
    message: "Card issue - contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "03": {
    code: "03",
    message: "Invalid merchant",
    isRetryable: false,
    userAction: "none",
  },
  "04": {
    code: "04",
    message: "Card reported lost or stolen",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "05": {
    code: "05",
    message: "Transaction declined by bank",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "06": {
    code: "06",
    message: "Card number error",
    isRetryable: true,
    userAction: "check_details",
  },
  "07": {
    code: "07",
    message: "Card reported lost or stolen",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "08": {
    code: "08",
    message: "Transaction Approved",
    isRetryable: false,
    userAction: "none",
  },
  "09": {
    code: "09",
    message: "Card issue - contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "10": {
    code: "10",
    message: "Partial amount approved",
    isRetryable: false,
    userAction: "none",
  },
  "11": {
    code: "11",
    message: "Transaction Approved",
    isRetryable: false,
    userAction: "none",
  },
  "12": {
    code: "12",
    message: "Invalid transaction",
    isRetryable: true,
    userAction: "check_details",
  },
  "13": {
    code: "13",
    message: "Invalid amount",
    isRetryable: true,
    userAction: "check_details",
  },
  "14": {
    code: "14",
    message: "Invalid card number",
    isRetryable: true,
    userAction: "check_details",
  },
  "15": {
    code: "15",
    message: "Bank not found",
    isRetryable: true,
    userAction: "check_details",
  },
  "16": {
    code: "16",
    message: "Transaction Approved",
    isRetryable: false,
    userAction: "none",
  },
  "19": {
    code: "19",
    message: "Please try again",
    isRetryable: true,
    userAction: "retry_later",
  },
  "21": {
    code: "21",
    message: "Card issue - contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "22": {
    code: "22",
    message: "Connection error - try again",
    isRetryable: true,
    userAction: "retry_later",
  },
  "23": {
    code: "23",
    message: "Transaction fee error",
    isRetryable: false,
    userAction: "none",
  },
  "25": {
    code: "25",
    message: "Card details not recognized",
    isRetryable: true,
    userAction: "check_details",
  },
  "30": {
    code: "30",
    message: "Format error - check details",
    isRetryable: true,
    userAction: "check_details",
  },
  "31": {
    code: "31",
    message: "Card not supported for this transaction",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "33": {
    code: "33",
    message: "Card has expired",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "34": {
    code: "34",
    message: "Suspected fraud",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "35": {
    code: "35",
    message: "Card reported lost or stolen",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "36": {
    code: "36",
    message: "Restricted card",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "37": {
    code: "37",
    message: "Card reported lost or stolen",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "38": {
    code: "38",
    message: "PIN tries exceeded",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "39": {
    code: "39",
    message: "No credit account linked",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "40": {
    code: "40",
    message: "Transaction type not supported",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "41": {
    code: "41",
    message: "Card reported lost",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "42": {
    code: "42",
    message: "Account type not valid",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "43": {
    code: "43",
    message: "Card reported stolen",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "44": {
    code: "44",
    message: "Account type not valid",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "51": {
    code: "51",
    message: "Insufficient funds",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "52": {
    code: "52",
    message: "No cheque account linked",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "53": {
    code: "53",
    message: "No savings account linked",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "54": {
    code: "54",
    message: "Card has expired",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "55": {
    code: "55",
    message: "Incorrect PIN",
    isRetryable: true,
    userAction: "check_details",
  },
  "56": {
    code: "56",
    message: "Card number not found",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "57": {
    code: "57",
    message: "Transaction not permitted for card",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "59": {
    code: "59",
    message: "Suspected fraud",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "60": {
    code: "60",
    message: "Contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "61": {
    code: "61",
    message: "Withdrawal limit exceeded",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "62": {
    code: "62",
    message: "Restricted card",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "63": {
    code: "63",
    message: "Security violation",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "64": {
    code: "64",
    message: "Incorrect amount",
    isRetryable: true,
    userAction: "check_details",
  },
  "65": {
    code: "65",
    message: "Withdrawal limit exceeded",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "66": {
    code: "66",
    message: "Contact your bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "67": {
    code: "67",
    message: "Suspected counterfeit card",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "75": {
    code: "75",
    message: "PIN tries exceeded",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "79": {
    code: "79",
    message: "Invalid card data",
    isRetryable: true,
    userAction: "check_details",
  },
  "82": {
    code: "82",
    message: "Incorrect CVV",
    isRetryable: true,
    userAction: "check_details",
  },
  "90": {
    code: "90",
    message: "Bank temporarily unavailable",
    isRetryable: true,
    userAction: "retry_later",
  },
  "91": {
    code: "91",
    message: "Bank could not be contacted",
    isRetryable: true,
    userAction: "retry_later",
  },
  "92": {
    code: "92",
    message: "Bank routing error",
    isRetryable: true,
    userAction: "retry_later",
  },
  "93": {
    code: "93",
    message: "Transaction declined by bank",
    isRetryable: false,
    userAction: "contact_bank",
  },
  "94": {
    code: "94",
    message: "Duplicate transaction",
    isRetryable: false,
    userAction: "none",
  },
  "96": {
    code: "96",
    message: "System error - try again",
    isRetryable: true,
    userAction: "retry_later",
  },
};

/** Map of common payment error messages to structured info */
const PAYMENT_ERROR_MESSAGES: Record<string, PaymentErrorInfo> = {
  "INSUFFICIENT FUNDS": {
    code: "INSUFFICIENT_FUNDS",
    message: "Insufficient funds",
    isRetryable: false,
    userAction: "use_different_card",
  },
  DECLINED: {
    code: "DECLINED",
    message: "Transaction declined by bank",
    isRetryable: false,
    userAction: "use_different_card",
  },
  BLOCKED: {
    code: "BLOCKED",
    message: "Transaction blocked",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "UNSPECIFIED FAILURE": {
    code: "UNSPECIFIED_FAILURE",
    message: "Bank declined for unspecified reason",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "EXPIRED CARD": {
    code: "EXPIRED_CARD",
    message: "Card has expired",
    isRetryable: false,
    userAction: "use_different_card",
  },
  "TIMED OUT": {
    code: "TIMED_OUT",
    message: "Connection timed out",
    isRetryable: true,
    userAction: "retry_later",
  },
  REFERRED: {
    code: "REFERRED",
    message: "Card number issue",
    isRetryable: false,
    userAction: "contact_bank",
  },
};

/** Map of 3DS error patterns to structured info */
const THREEDS_ERROR_PATTERNS: Array<{
  pattern: RegExp;
  info: PaymentErrorInfo;
}> = [
  {
    pattern: /AUTHENTICATION_FAILED/i,
    info: {
      code: "3DS_AUTH_FAILED",
      message: "3D Secure authentication failed",
      isRetryable: true,
      userAction: "retry_later",
    },
  },
  {
    pattern: /AUTHENTICATION_ATTEMPTED/i,
    info: {
      code: "3DS_NOT_ENROLLED",
      message: "Card not enrolled in 3D Secure",
      isRetryable: false,
      userAction: "contact_bank",
    },
  },
  {
    pattern: /AUTHENTICATION_NOT_AVAILABLE/i,
    info: {
      code: "3DS_NOT_AVAILABLE",
      message: "3D Secure not available",
      isRetryable: false,
      userAction: "contact_bank",
    },
  },
  {
    pattern: /CARD_NOT_ENROLLED/i,
    info: {
      code: "3DS_NOT_ENROLLED",
      message: "Card not enrolled in 3D Secure",
      isRetryable: false,
      userAction: "contact_bank",
    },
  },
  {
    pattern: /Missing parameter/i,
    info: {
      code: "3DS_MISSING_PARAM",
      message: "Authentication error",
      isRetryable: true,
      userAction: "retry_later",
    },
  },
  {
    pattern: /card type VC/i,
    info: {
      code: "3DS_VISA_NOT_CONFIGURED",
      message: "Visa not configured for this merchant",
      isRetryable: false,
      userAction: "use_different_card",
    },
  },
  {
    pattern: /card type MC/i,
    info: {
      code: "3DS_MC_NOT_CONFIGURED",
      message: "MasterCard not configured for this merchant",
      isRetryable: false,
      userAction: "use_different_card",
    },
  },
  {
    pattern: /Cannot determine card brand/i,
    info: {
      code: "3DS_INVALID_CARD",
      message: "Invalid card number",
      isRetryable: true,
      userAction: "check_details",
    },
  },
  {
    pattern: /Unable to determine card payment/i,
    info: {
      code: "3DS_INVALID_CARD",
      message: "Invalid card number",
      isRetryable: true,
      userAction: "check_details",
    },
  },
  {
    pattern: /Amount exceeds maximum/i,
    info: {
      code: "3DS_AMOUNT_EXCEEDED",
      message: "Amount exceeds transaction limit",
      isRetryable: false,
      userAction: "none",
    },
  },
  {
    pattern: /Invalid secure code length/i,
    info: {
      code: "3DS_INVALID_CVV",
      message: "Invalid security code",
      isRetryable: true,
      userAction: "check_details",
    },
  },
  {
    pattern: /time frame.*expired/i,
    info: {
      code: "3DS_EXPIRED",
      message: "Payment session expired",
      isRetryable: true,
      userAction: "retry_later",
    },
  },
];

/** HTTP status code messages */
const HTTP_STATUS_MESSAGES: Record<
  number,
  { message: string; isRetryable: boolean }
> = {
  400: { message: "Invalid request parameters", isRetryable: false },
  401: { message: "Invalid API credentials", isRetryable: false },
  403: { message: "Access forbidden", isRetryable: false },
  404: { message: "Resource not found", isRetryable: false },
  405: {
    message: "Account not activated for live payments",
    isRetryable: false,
  },
  429: { message: "Too many requests - please slow down", isRetryable: true },
  500: { message: "Payment service error", isRetryable: true },
  503: {
    message: "Payment service temporarily unavailable",
    isRetryable: true,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Comprehensive Moyasar adapter error with user-friendly messages
 */
export class MoyasarAdapterError extends Error {
  constructor(
    message: string,
    public readonly type:
      | MoyasarErrorType
      | "http_error"
      | "payment_declined"
      | "network_error" = "api_error",
    public readonly code: string = "UNKNOWN",
    public readonly httpStatus?: number,
    public readonly userMessage?: string,
    public readonly isRetryable: boolean = false,
    public readonly userAction: PaymentErrorInfo["userAction"] = "none",
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "MoyasarAdapterError";
  }

  /** Create from HTTP response */
  static fromHttpResponse(
    status: number,
    errorResponse?: MoyasarErrorResponse,
  ): MoyasarAdapterError {
    const httpInfo = HTTP_STATUS_MESSAGES[status] ?? {
      message: `HTTP error ${status}`,
      isRetryable: status >= 500,
    };

    const type: MoyasarErrorType | "http_error" =
      typeof errorResponse?.type === "string" ? errorResponse.type : "http_error";
    const fieldErrors = errorResponse?.errors && typeof errorResponse.errors === "object" && Object.values(errorResponse.errors).every(messages => Array.isArray(messages) && messages.every(message => typeof message === "string")) ? errorResponse.errors : undefined;

    // Build detailed message if field errors exist
    let detailedMessage = typeof errorResponse?.message === "string" ? errorResponse.message : httpInfo.message;
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      const errorDetails = Object.entries(fieldErrors)
        .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
        .join("; ");
      detailedMessage = `${detailedMessage} (${errorDetails})`;
    }

    return new MoyasarAdapterError(
      detailedMessage,
      type,
      type.toUpperCase().replace(/_/g, "_"),
      status,
      httpInfo.message,
      httpInfo.isRetryable,
      "none",
      fieldErrors,
    );
  }

  /** Create from payment source message (bank decline, 3DS failure, etc.) */
  static fromPaymentMessage(
    message: string,
    paymentId?: string,
  ): MoyasarAdapterError {
    // Check gateway response codes
    const responseCodeMatch = message.match(/response_code[:\s]*([\d]{2})/i);
    if (responseCodeMatch) {
      const code = responseCodeMatch[1]!;
      const info = GATEWAY_RESPONSE_CODES[code];
      if (info) {
        return new MoyasarAdapterError(
          `Payment declined: ${info.message}`,
          "payment_declined",
          `GATEWAY_${code}`,
          undefined,
          info.message,
          info.isRetryable,
          info.userAction,
        );
      }
    }

    // Check known payment error messages
    const upperMessage = message.toUpperCase();
    for (const [key, info] of Object.entries(PAYMENT_ERROR_MESSAGES)) {
      if (upperMessage.includes(key)) {
        return new MoyasarAdapterError(
          `Payment declined: ${info.message}`,
          "payment_declined",
          info.code,
          undefined,
          info.message,
          info.isRetryable,
          info.userAction,
        );
      }
    }

    // Check 3DS error patterns
    if (message.includes("3-D Secure") || message.includes("3DS")) {
      for (const { pattern, info } of THREEDS_ERROR_PATTERNS) {
        if (pattern.test(message)) {
          return new MoyasarAdapterError(
            `3DS authentication failed: ${info.message}`,
            "3ds_auth_error",
            info.code,
            undefined,
            info.message,
            info.isRetryable,
            info.userAction,
          );
        }
      }
    }

    // Default payment failure
    return new MoyasarAdapterError(
      `Payment failed: ${message}`,
      "payment_declined",
      "PAYMENT_FAILED",
      undefined,
      "Payment could not be processed",
      false,
      "use_different_card",
    );
  }

  /** Create from gateway response code */
  static fromGatewayCode(code: string): MoyasarAdapterError {
    const info = GATEWAY_RESPONSE_CODES[code];
    if (info) {
      return new MoyasarAdapterError(
        info.message,
        "payment_declined",
        `GATEWAY_${code}`,
        undefined,
        info.message,
        info.isRetryable,
        info.userAction,
      );
    }

    return new MoyasarAdapterError(
      `Unknown gateway response: ${code}`,
      "payment_declined",
      `GATEWAY_${code}`,
      undefined,
      "Payment could not be processed",
      false,
      "use_different_card",
    );
  }
}

/** Helper to extract error info from a payment response */
export function getPaymentErrorInfo(
  payment: MoyasarPayment,
): PaymentErrorInfo | null {
  if (payment.status !== "failed") return null;

  // Try response code first
  const responseCode = payment.source.response_code;
  if (responseCode && GATEWAY_RESPONSE_CODES[responseCode]) {
    return GATEWAY_RESPONSE_CODES[responseCode]!;
  }

  // Try source message
  const message = payment.source.message;
  if (message) {
    // Check known error messages
    const upperMessage = message.toUpperCase();
    for (const [key, info] of Object.entries(PAYMENT_ERROR_MESSAGES)) {
      if (upperMessage.includes(key)) {
        return info;
      }
    }

    // Check 3DS patterns
    for (const { pattern, info } of THREEDS_ERROR_PATTERNS) {
      if (pattern.test(message)) {
        return info;
      }
    }
  }

  return {
    code: "UNKNOWN",
    message: "Payment failed",
    isRetryable: false,
    userAction: "use_different_card",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function invalidResponse(message: string): MoyasarAdapterError {
  return new MoyasarAdapterError(message, "api_error", "INVALID_RESPONSE", undefined, message, true, "retry_later");
}

function validatePayment(value: unknown): MoyasarPayment {
  if (!value || typeof value !== "object") throw invalidResponse("Invalid payment response");
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id ||
      !["initiated", "paid", "failed", "authorized", "captured", "refunded", "voided", "verified"].includes(String(data.status)) ||
      !Number.isSafeInteger(data.amount) || Number(data.amount) < 0 ||
      typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency) ||
      !data.source || typeof data.source !== "object" ||
      typeof data.created_at !== "string" || !Number.isFinite(Date.parse(data.created_at)) ||
      (data.status === "captured" && (!Number.isSafeInteger(data.captured) || Number(data.captured) <= 0 || Number(data.captured) > Number(data.amount)))) {
    throw invalidResponse("Invalid payment response");
  }
  return value as MoyasarPayment;
}

function validateToken(value: unknown): MoyasarToken {
  if (!value || typeof value !== "object") throw invalidResponse("Invalid token response");
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id ||
      !["initiated", "active", "inactive"].includes(String(data.status)) ||
      typeof data.brand !== "string" || typeof data.last_four !== "string") {
    throw invalidResponse("Invalid token response");
  }
  return value as MoyasarToken;
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    throw new MoyasarAdapterError("Moyasar collection requires a persisted UUID idempotencyKey", "invalid_request_error", "IDEMPOTENCY_KEY_REQUIRED");
  }
  return key;
}

function validateAmount(amount: number, currency: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new MoyasarAdapterError("Payment amount must be a positive integer in minor units and currency a three-letter uppercase code", "invalid_request_error", "INVALID_AMOUNT");
  }
}

/** WebCrypto performs the final comparison without exposing a timing-dependent string comparison. */
async function equalSecret(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(expected), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(received));
}

function toPayment(payment: MoyasarPayment): GatewayPayment {
  const status: ChargePaymentResult["status"] =
    payment.status === "paid" || payment.status === "captured" ? "paid" :
    payment.status === "authorized" ? "authorized" :
    payment.status === "initiated" || payment.status === "verified" ? "pending" : "failed";
  const info = getPaymentErrorInfo(payment);
  return {
    id: payment.id,
    status,
    amount: payment.status === "captured" ? payment.captured : payment.amount,
    currency: payment.currency,
    createdAt: new Date(payment.created_at),
    ...(payment.metadata && { metadata: payment.metadata }),
    ...(payment.source.token && { paymentMethodId: payment.source.token }),
    ...(payment.source.transaction_url && { verificationUrl: payment.source.transaction_url }),
    ...(status === "failed" && {
      errorMessage: info?.message ?? payment.source.message ?? "Payment is not settled",
      errorCode: info?.code ?? payment.status.toUpperCase(),
      isRetryable: info?.isRetryable ?? false,
      userAction: info?.userAction ?? "none",
    }),
  };
}

/** Token charges are SDK-managed. Moyasar has no native subscription/customer/portal resource. */
export function moyasarAdapter(config: MoyasarConfig): PaymentGatewayAdapter {
  const client = new MoyasarClient(config);
  const environment = config.environment ?? (config.secretKey.startsWith("sk_test_") ? "test" : config.secretKey.startsWith("sk_live_") ? "live" : undefined);
  const unsupported = async (): Promise<never> => {
    throw new MoyasarAdapterError("Moyasar does not support native customers, subscriptions, hosted checkout sessions, or customer portals. Use SDK-managed subscriptions, token payments, and getEmbeddedCheckoutConfiguration().", "invalid_request_error", "UNSUPPORTED_OPERATION");
  };
  return {
    provider: "moyasar",
    capabilities: { customers: false, nativeSubscriptions: false, checkout: "embedded", portal: false, directPayments: true, paymentLookup: true, idempotentCharges: true },
    createCustomer: unsupported,
    getCustomer: unsupported,
    createSubscription: unsupported,
    getSubscription: unsupported,
    updateSubscription: unsupported,
    cancelSubscription: unsupported,
    createCheckoutSession: unsupported,
    createPortalSession: unsupported,

    getEmbeddedCheckoutConfiguration(data) {
      validateAmount(data.amount, data.currency);
      if (!config.publishableKey) throw new MoyasarAdapterError("A publishable key is required for embedded checkout", "invalid_request_error", "PUBLISHABLE_KEY_REQUIRED");
      return {
        provider: "moyasar", amount: data.amount, currency: data.currency,
        publishable_api_key: config.publishableKey,
        callback_url: data.callbackUrl ?? config.callbackUrl,
        ...(data.description && { description: data.description }),
        ...(data.metadata && { metadata: data.metadata }),
      };
    },

    async constructWebhookEvent(payload, _signature, _context): Promise<WebhookEvent> {
      if (!config.webhookSecret) throw new MoyasarAdapterError("Moyasar webhookSecret is required", "authentication_error", "WEBHOOK_SECRET_REQUIRED");
      const raw = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object") throw invalidResponse("Invalid webhook payload");
      const event = value as MoyasarWebhookPayload;
      if (typeof event.secret_token !== "string" || !await equalSecret(event.secret_token, config.webhookSecret)) {
        throw new MoyasarAdapterError("Invalid webhook secret_token", "authentication_error", "WEBHOOK_SECRET_INVALID");
      }
      if (typeof event.id !== "string" || !event.id || typeof event.type !== "string" ||
          typeof event.live !== "boolean" || typeof event.account_name !== "string" ||
          !Number.isFinite(Date.parse(event.created_at))) throw invalidResponse("Invalid webhook envelope");
      if ((environment && event.live !== (environment === "live")) ||
          (config.accountName && event.account_name !== config.accountName)) {
        throw new MoyasarAdapterError("Webhook provider account or environment mismatch", "authentication_error", "WEBHOOK_SCOPE_MISMATCH");
      }
      // Nonpayment authentication events are intentionally not settlement evidence.
      const isPayment = event.type.startsWith("payment_");
      const payment = isPayment ? validatePayment(event.data) : undefined;
      let type = event.type;
      if (event.type === "payment_paid" || event.type === "payment_captured") {
        if (!payment || (payment.status !== "paid" && payment.status !== "captured")) throw invalidResponse("Settlement event does not describe a settled payment");
        type = "payment.paid";
      } else if (event.type === "payment_failed") {
        if (!payment || payment.status !== "failed") throw invalidResponse("Failure event does not describe a failed payment");
        type = "payment.failed";
      } else if (event.type === "payment_authorized") {
        type = "payment.authorized";
      }
      return {
        id: event.id, type, originalType: event.type,
        environment: event.live ? "live" : "test", accountName: event.account_name,
        data: { ...event.data, ...(payment && { paymentId: payment.id, paymentMethodId: payment.source.token, amount: payment.status === "captured" ? payment.captured : payment.amount }) },
        createdAt: new Date(event.created_at),
      };
    },

    async chargePayment(data: ChargePaymentInput): Promise<ChargePaymentResult> {
      const idempotencyKey = requireIdempotencyKey(data.idempotencyKey);
      validateAmount(data.amount, data.currency);
      try {
        const payment = await client.createPayment({
          givenId: idempotencyKey, amount: data.amount, currency: data.currency,
          ...(data.description && { description: data.description }),
          callbackUrl: data.callbackUrl ?? config.callbackUrl,
          source: { type: "token", token: data.paymentMethodId ?? data.customerId },
          ...(data.metadata && { metadata: data.metadata }),
        });
        if (payment.id !== idempotencyKey || payment.amount !== data.amount || payment.currency !== data.currency) {
          throw invalidResponse("Provider response does not match the persisted payment attempt");
        }
        return toPayment(payment);
      } catch (error) {
        const known = error instanceof MoyasarAdapterError;
        const uncertain = !known || error.type === "network_error" || error.code === "INVALID_RESPONSE" || (error.httpStatus !== undefined && error.httpStatus >= 500);
        return {
          id: uncertain ? idempotencyKey : "", status: uncertain ? "unknown" : "failed",
          amount: data.amount, currency: data.currency,
          errorMessage: known ? error.userMessage ?? error.message : error instanceof Error ? error.message : "Unknown collection outcome",
          errorCode: known ? error.code : "UNKNOWN_OUTCOME",
          isRetryable: known ? error.isRetryable : true,
          userAction: "retry_later",
          ...(known && error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
        };
      }
    },

    async getPayment(paymentId): Promise<GatewayPayment | null> {
      try { return toPayment(await client.getPayment(paymentId)); }
      catch (error) { if (error instanceof MoyasarAdapterError && error.httpStatus === 404) return null; throw error; }
    },

    async getPaymentMethod(paymentMethodId): Promise<GatewayPaymentMethod | null> {
      try {
        const token = await client.getToken(paymentMethodId);
        return { id: token.id, status: token.status === "initiated" ? "pending" : token.status,
          metadata: { brand: token.brand, lastFour: token.last_four, expiry: `${token.month}/${token.year}` } };
      } catch (error) { if (error instanceof MoyasarAdapterError && error.httpStatus === 404) return null; throw error; }
    },

    async getPaymentSource(paymentId): Promise<string | null> {
      try {
        const payment = await client.getPayment(paymentId);
        return (payment.status === "paid" || payment.status === "captured") ? payment.source.token ?? null : null;
      } catch (error) { if (error instanceof MoyasarAdapterError && error.httpStatus === 404) return null; throw error; }
    },
  };
}

/** Charge a saved token with a persisted logical UUID; callers own renewal scheduling. */
export async function chargeToken(params: {
  secretKey: string;
  tokenId: string;
  amount: number;
  currency?: string;
  description?: string;
  callbackUrl: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}): Promise<MoyasarPayment> {
  const givenId = requireIdempotencyKey(params.idempotencyKey);
  validateAmount(params.amount, params.currency ?? "SAR");
  const client = new MoyasarClient({ secretKey: params.secretKey, publishableKey: "", callbackUrl: params.callbackUrl });
  return client.createPayment({
    givenId, amount: params.amount, currency: params.currency ?? "SAR",
    description: params.description ?? "Subscription renewal", callbackUrl: params.callbackUrl,
    source: { type: "token", token: params.tokenId },
    ...(params.metadata && { metadata: params.metadata }),
  });
}
