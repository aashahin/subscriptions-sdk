// file: packages/subscriptions/src/adapters/moyasar.adapter.ts
// Moyasar payment gateway adapter for subscriptions package
// NOTE: Moyasar does NOT support native subscriptions - we use token-based recurring payments

import type {
  CancelOptions,
  ChargePaymentInput,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreateGatewaySubscriptionInput,
  GatewayCustomer,
  GatewaySubscription,
  PaymentGatewayAdapter,
  PortalSession,
  UpdateGatewaySubscriptionInput,
  WebhookEvent,
} from "./payment.adapter";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface MoyasarConfig {
  /** Secret API key (sk_live_xxx or sk_test_xxx) */
  secretKey: string;
  /** Publishable API key for frontend (pk_live_xxx or pk_test_xxx) */
  publishableKey: string;
  /** Webhook secret for signature verification */
  webhookSecret?: string;
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
  | "voided";

/** Moyasar token status */
export type MoyasarTokenStatus = "initiated" | "verified" | "failed";

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
  type:
    | "payment.created"
    | "payment.updated"
    | "payment.paid"
    | "payment.failed";
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

    // Debug logging for troubleshooting
    console.log("[Moyasar] Request:", {
      method,
      path,
      body: body ? JSON.stringify(body) : undefined,
    });

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
      // Log error response for debugging
      console.error("[Moyasar] Error response:", {
        status: response.status,
        data: JSON.stringify(data),
      });
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
  }): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>("POST", "/payments", {
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      callback_url: params.callbackUrl,
      source: params.source,
      metadata: params.metadata,
    });
  }

  async getPayment(id: string): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>("GET", `/payments/${id}`);
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
    return this.request<MoyasarToken>("GET", `/tokens/${id}`);
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
      isRetryable: false,
    };

    const type: MoyasarErrorType | "http_error" =
      errorResponse?.type ?? "http_error";
    const fieldErrors = errorResponse?.errors;

    // Build detailed message if field errors exist
    let detailedMessage = errorResponse?.message ?? httpInfo.message;
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

function mapPaymentStatus(status: MoyasarPaymentStatus): string {
  const statusMap: Record<MoyasarPaymentStatus, string> = {
    initiated: "incomplete",
    paid: "active",
    failed: "incomplete_expired",
    authorized: "active",
    captured: "active",
    refunded: "canceled",
    voided: "canceled",
  };
  return statusMap[status] ?? "incomplete";
}

async function verifySignature(
  payload: string,
  signature: string,
  webhookSecret: string,
): Promise<boolean> {
  // Moyasar uses HMAC-SHA256 for webhook signatures
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  const computedSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computedSignature === signature;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Moyasar payment adapter for subscriptions.
 *
 * **Important**: Moyasar doesn't have native subscription support.
 * This adapter uses token-based recurring payments:
 *
 * 1. Frontend collects card → creates token via Moyasar.js
 * 2. Token stored as `gatewayCustomerId` in subscription
 * 3. Renewal job charges token using `createSubscription()` method
 * 4. Webhook confirms payment → subscription renewed
 *
 * @example
 * ```typescript
 * import { moyasarAdapter } from '@abshahin/subscriptions/adapters/moyasar';
 *
 * const payment = moyasarAdapter({
 *   secretKey: process.env.MOYASAR_LIVE_SECRET_KEY!,
 *   publishableKey: process.env.MOYASAR_LIVE_PUBLIC_KEY!,
 *   callbackUrl: 'https://platform.example.com/subscriptions/callback',
 * });
 * ```
 */
export function moyasarAdapter(config: MoyasarConfig): PaymentGatewayAdapter {
  const client = new MoyasarClient(config);

  return {
    provider: "moyasar",

    // ==================== Customer Management ====================
    // Moyasar has no customer concept - we store token ID as customer ID

    async createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer> {
      // No API call - return local customer object
      // Token ID will be set later via updateCustomer or stored during checkout
      return {
        id: `moy_cust_${Date.now()}`, // Local ID
        email: data.email,
        ...(data.name && { name: data.name }),
        ...(data.metadata && { metadata: data.metadata }),
      };
    },

    async getCustomer(customerId: string): Promise<GatewayCustomer | null> {
      // If customerId is a Moyasar token, fetch token details
      if (customerId.startsWith("token_")) {
        try {
          const token = await client.getToken(customerId);
          return {
            id: token.id,
            email: "", // Tokens don't have email
            name: token.name,
            metadata: {
              brand: token.brand,
              lastFour: token.last_four,
              expiry: `${token.month}/${token.year}`,
            },
          };
        } catch {
          return null;
        }
      }
      return null;
    },

    // ==================== Subscription Management ====================
    // Since Moyasar has no subscriptions, we charge tokens for recurring payments

    async createSubscription(
      data: CreateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      // priceId is amount in smallest unit (e.g., 9900 = 99.00 SAR)
      const amount = parseInt(data.priceId, 10);

      if (isNaN(amount) || amount <= 0) {
        throw new MoyasarAdapterError(
          "priceId must be a valid amount in smallest currency unit",
        );
      }

      // Charge the token
      const payment = await client.createPayment({
        amount,
        currency: "SAR",
        description: `Subscription payment for ${data.customerId}`,
        callbackUrl: config.callbackUrl,
        source: {
          type: "token",
          token: data.customerId, // Token ID stored as customerId
        },
        metadata: {
          ...data.metadata,
          subscriberId: data.customerId,
          type: "subscription_payment",
        },
      });

      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1); // Default monthly

      return {
        id: payment.id,
        customerId: data.customerId,
        status: mapPaymentStatus(payment.status),
        priceId: data.priceId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAt: null,
        canceledAt: null,
        trialStart: data.trialDays ? now : null,
        trialEnd: data.trialDays
          ? new Date(now.getTime() + data.trialDays * 24 * 60 * 60 * 1000)
          : null,
        ...(data.metadata && { metadata: data.metadata }),
      };
    },

    async getSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription | null> {
      // subscriptionId is actually a payment ID for Moyasar
      try {
        const payment = await client.getPayment(subscriptionId);
        const createdAt = new Date(payment.created_at);
        const periodEnd = new Date(createdAt);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        return {
          id: payment.id,
          customerId: payment.metadata?.subscriberId ?? "",
          status: mapPaymentStatus(payment.status),
          currentPeriodStart: createdAt,
          currentPeriodEnd: periodEnd,
          cancelAt: null,
          canceledAt: null,
          trialStart: null,
          trialEnd: null,
          ...(payment.metadata && { metadata: payment.metadata }),
        };
      } catch {
        return null;
      }
    },

    async updateSubscription(
      _subscriptionId: string,
      _data: UpdateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      // Moyasar doesn't support subscription updates
      throw new MoyasarAdapterError(
        "Moyasar does not support subscription updates. Cancel and create a new subscription instead.",
      );
    },

    async cancelSubscription(
      subscriptionId: string,
      options?: CancelOptions,
    ): Promise<GatewaySubscription> {
      // Void the payment if immediate cancellation requested
      if (options?.immediately) {
        try {
          const payment = await client.voidPayment(subscriptionId);
          return {
            id: payment.id,
            customerId: payment.metadata?.subscriberId ?? "",
            status: "canceled",
            currentPeriodStart: new Date(payment.created_at),
            currentPeriodEnd: new Date(payment.created_at),
            cancelAt: new Date(),
            canceledAt: new Date(),
            trialStart: null,
            trialEnd: null,
            ...(payment.metadata && { metadata: payment.metadata }),
          };
        } catch {
          // Payment may already be captured/completed
        }
      }

      // For non-immediate cancellation, just return updated status
      // The actual subscription record update happens in the subscriptions service
      const payment = await client.getPayment(subscriptionId);
      const createdAt = new Date(payment.created_at);
      const periodEnd = new Date(createdAt);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      return {
        id: payment.id,
        customerId: payment.metadata?.subscriberId ?? "",
        status: mapPaymentStatus(payment.status),
        currentPeriodStart: createdAt,
        currentPeriodEnd: periodEnd,
        cancelAt: periodEnd,
        canceledAt: new Date(),
        trialStart: null,
        trialEnd: null,
        ...(payment.metadata && { metadata: payment.metadata }),
      };
    },

    // ==================== Checkout & Portal ====================

    async createCheckoutSession(
      data: CreateCheckoutInput,
    ): Promise<CheckoutSession> {
      // For Moyasar, checkout is handled via their embedded form
      // Return URL to frontend checkout page with config
      const params = new URLSearchParams({
        publishable_key: config.publishableKey,
        amount: data.priceId,
        currency: "SAR",
        callback_url: data.successUrl,
        ...(data.metadata && { metadata: JSON.stringify(data.metadata) }),
      });

      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      return {
        id: `moy_checkout_${Date.now()}`,
        // This URL should point to your frontend checkout page
        url: `${data.successUrl.split("?")[0]}/checkout?${params.toString()}`,
        expiresAt,
      };
    },

    async createPortalSession(
      _customerId: string,
      returnUrl: string,
    ): Promise<PortalSession> {
      // Moyasar doesn't have a customer portal
      // Return URL to your own billing management page
      return {
        id: `moy_portal_${Date.now()}`,
        url: `${returnUrl}/billing`,
      };
    },

    // ==================== Webhooks ====================

    async constructWebhookEvent(
      payload: string | Buffer,
      signature: string,
    ): Promise<WebhookEvent> {
      const payloadStr =
        typeof payload === "string" ? payload : payload.toString("utf-8");

      // Verify signature if webhook secret is configured
      if (config.webhookSecret && signature) {
        const isValid = await verifySignature(
          payloadStr,
          signature,
          config.webhookSecret,
        );
        if (!isValid) {
          throw new MoyasarAdapterError("Invalid webhook signature");
        }
      }

      const webhookData = JSON.parse(payloadStr) as MoyasarWebhookPayload;

      return {
        id: webhookData.id,
        type: webhookData.type,
        data: webhookData.data as unknown as Record<string, unknown>,
        createdAt: new Date(webhookData.created_at),
      };
    },

    // ==================== Direct Payment ====================

    async chargePayment(data: ChargePaymentInput) {
      try {
        const payment = await client.createPayment({
          amount: data.amount,
          currency: data.currency,
          ...(data.description && { description: data.description }),
          callbackUrl: data.callbackUrl ?? config.callbackUrl,
          source: {
            type: "token",
            token: data.customerId, // Token ID stored as customerId
          },
          ...(data.metadata && { metadata: data.metadata }),
        });

        // Map Moyasar status to our status
        let status: "paid" | "pending" | "failed";
        if (payment.status === "paid" || payment.status === "captured") {
          status = "paid";
        } else if (payment.status === "initiated") {
          status = "pending";
        } else {
          status = "failed";
        }

        // Extract detailed error info for failed payments
        if (status === "failed") {
          const errorInfo = getPaymentErrorInfo(payment);
          return {
            id: payment.id,
            status,
            amount: payment.amount,
            currency: payment.currency,
            errorMessage:
              errorInfo?.message ?? payment.source.message ?? "Payment failed",
            errorCode: errorInfo?.code ?? "UNKNOWN",
            isRetryable: errorInfo?.isRetryable ?? false,
            userAction: errorInfo?.userAction ?? "use_different_card",
            ...(payment.source.response_code && {
              gatewayCode: payment.source.response_code,
            }),
          };
        }

        return {
          id: payment.id,
          status,
          amount: payment.amount,
          currency: payment.currency,
          ...(payment.source.transaction_url && {
            verificationUrl: payment.source.transaction_url,
          }),
        };
      } catch (error) {
        // Handle MoyasarAdapterError with rich error info
        if (error instanceof MoyasarAdapterError) {
          return {
            id: "",
            status: "failed" as const,
            amount: data.amount,
            currency: data.currency,
            errorMessage: error.userMessage ?? error.message,
            errorCode: error.code,
            isRetryable: error.isRetryable,
            userAction: error.userAction,
            ...(error.httpStatus && { httpStatus: error.httpStatus }),
          };
        }

        // Handle generic errors
        const errorMessage =
          error instanceof Error ? error.message : "Payment failed";
        return {
          id: "",
          status: "failed" as const,
          amount: data.amount,
          currency: data.currency,
          errorMessage,
          errorCode: "UNKNOWN",
          isRetryable: false,
          userAction: "retry_later" as const,
        };
      }
    },

    /**
     * Get the reusable payment source (token) from a completed payment.
     * Use this to save the payment method for future renewals.
     */
    async getPaymentSource(paymentId: string): Promise<string | null> {
      try {
        const payment = await client.getPayment(paymentId);

        // If payment has a source token and is paid, return it
        if (payment.status === "paid" && payment.source.token) {
          return payment.source.token;
        }

        return null;
      } catch (error) {
        console.error("[Moyasar] Failed to get payment source:", error);
        return null;
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Charge Token Utility (for renewal job)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Charge a saved token for subscription renewal.
 * Use this in your renewal cron job.
 *
 * @example
 * ```typescript
 * import { chargeToken } from '@abshahin/subscriptions/adapters/moyasar';
 *
 * // In your renewal cron job:
 * const result = await chargeToken({
 *   secretKey: process.env.MOYASAR_LIVE_SECRET_KEY!,
 *   tokenId: subscription.gatewayCustomerId!,
 *   amount: plan.price * 100, // Convert to smallest unit
 *   description: `Renewal for ${subscription.tenantId}`,
 *   callbackUrl: 'https://platform.example.com/subscriptions/callback',
 *   metadata: { tenantId: subscription.tenantId, planId: subscription.planId },
 * });
 * ```
 */
export async function chargeToken(params: {
  secretKey: string;
  tokenId: string;
  amount: number;
  currency?: string;
  description?: string;
  callbackUrl: string;
  metadata?: Record<string, string>;
}): Promise<MoyasarPayment> {
  const client = new MoyasarClient({
    secretKey: params.secretKey,
    publishableKey: "", // Not needed for server-side
    callbackUrl: params.callbackUrl,
  });

  return client.createPayment({
    amount: params.amount,
    currency: params.currency ?? "SAR",
    description: params.description ?? "Subscription renewal",
    callbackUrl: params.callbackUrl,
    source: {
      type: "token",
      token: params.tokenId,
    },
    ...(params.metadata && { metadata: params.metadata }),
  });
}
