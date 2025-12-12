import crypto from "crypto";

// Chuẩn hoá encode theo yêu cầu VNPAY (space => +)
function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/%20/g, "+").replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16));
}

// Tạo chuỗi ký (sort theo key, encode value)
function buildSignedQuery(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const signData = sortedKeys.map(k => `${k}=${encodeRFC3986(params[k])}`).join("&");
  const hmac = crypto.createHmac("sha512", secret);
  const secureHash = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");
  return { signData, secureHash };
}

export function buildVNPayPayUrl({
  vnpUrl,
  tmnCode,
  hashSecret,
  amountVND,
  orderInfo,
  txnRef,        // booking.code hoặc code kèm timestamp
  ipAddr,
  returnUrl,
  locale = "vn",
  currCode = "VND",
  bankCode      // optional
}) {
  // Validate required parameters
  if (!vnpUrl || !tmnCode || !hashSecret || !amountVND || !orderInfo || !txnRef || !returnUrl) {
    throw new Error("Missing required VNPay parameters");
  }

  // Ensure amount is a valid positive integer
  const amount = parseInt(amountVND);
  if (isNaN(amount) || amount <= 0) {
    throw new Error("Invalid amount: must be a positive integer");
  }
  
  // VNPay minimum amount is 10,000 VND
  // For testing purposes, we allow lower amounts but log a warning
  if (amount < 10000) {
    console.warn(`⚠️  VNPay minimum amount is 10,000 VND. Current amount: ${amount} VND`);
    console.warn("   VNPay sandbox may reject this payment.");
  }

  // Clean and validate orderInfo (VNPay only allows alphanumeric and spaces)
  const cleanOrderInfo = String(orderInfo).replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (!cleanOrderInfo) {
    throw new Error("Invalid orderInfo: must contain at least one alphanumeric character");
  }

  // Clean txnRef (max 100 chars, alphanumeric only)
  const cleanTxnRef = String(txnRef).replace(/[^a-zA-Z0-9]/g, '').slice(0, 100);
  if (!cleanTxnRef) {
    throw new Error("Invalid txnRef: must contain alphanumeric characters");
  }

  // Validate IP address format
  const cleanIP = ipAddr || "127.0.0.1";
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanIP)) {
    throw new Error("Invalid IP address format");
  }

  const vnp_Params = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: tmnCode,
    vnp_Amount: String(amount * 100),      // nhân 100
    vnp_CurrCode: currCode,
    vnp_TxnRef: cleanTxnRef,
    vnp_OrderInfo: cleanOrderInfo,
    vnp_Locale: locale,
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: cleanIP,
    vnp_CreateDate: new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0,14), // yyyyMMddHHmmss
  };
  if (bankCode) vnp_Params.vnp_BankCode = bankCode;

  console.log("VNPay params before signing:", vnp_Params);

  // Ký
  const { secureHash, signData } = buildSignedQuery(vnp_Params, hashSecret);
  console.log("VNPay sign data:", signData);
  console.log("VNPay secure hash:", secureHash);
  
  vnp_Params.vnp_SecureHashType = "HMACSHA512";
  vnp_Params.vnp_SecureHash = secureHash;

  // Build URL
  const queryStr = Object.keys(vnp_Params)
    .sort()
    .map(k => `${k}=${encodeRFC3986(vnp_Params[k])}`)
    .join("&");

  return `${vnpUrl}?${queryStr}`;
}

// Xác minh chữ ký trả về từ VNPAY (return/IPN)
export function verifyVNPayChecksum(query, hashSecret) {
  const params = { ...query };
  const secureHash = params.vnp_SecureHash;
  const secureHashType = params.vnp_SecureHashType;
  delete params.vnp_SecureHash;
  delete params.vnp_SecureHashType;

  const sortedKeys = Object.keys(params).sort();
  const signData = sortedKeys.map(k => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, "+")}`).join("&");

  const hmac = crypto.createHmac("sha512", hashSecret);
  const signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");

  return { ok: signed === secureHash, signed, secureHash, secureHashType };
}
