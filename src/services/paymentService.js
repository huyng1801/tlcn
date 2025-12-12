import { VNPay, VnpLocale } from 'vnpay';

class PaymentService {
  constructor() {
    this.vnpay = new VNPay({
      tmnCode: process.env.VNP_TMN_CODE,
      secureSecret: process.env.VNP_HASH_SECRET,
      vnpayHost: process.env.VNP_URL,
      vnp_OrderType: 'other',
      testMode: true,
      hashAlgorithm: 'SHA512',
      enableLog: true
    });
  }

  /**
   * Create VNPay payment URL for booking
   * @param {Object} bookingData - { id, code, totalPrice, tourId, returnUrl }
   * @returns {string} Payment URL
   */
  createVNPayUrl(bookingData) {
    try {
      // Sanitize orderInfo - only alphanumeric and spaces
      const sanitizedOrderInfo = `Thanh toan tour ${bookingData.tourId || 'unknown'}`
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim();

      // Validate amount
      if (bookingData.totalPrice < 10000) {
        console.warn("⚠️  WARNING: Amount", bookingData.totalPrice, "is below VNPay minimum 10,000 VND");
      }

      const vnpParams = {
        vnp_Amount: bookingData.totalPrice * 100, // VNPay expects amount in 1/100 VND
        vnp_IpAddr: bookingData.ipAddr || '127.0.0.1',
        vnp_TxnRef: bookingData.code || bookingData.id.toString(),
        vnp_OrderInfo: sanitizedOrderInfo,
        vnp_ReturnUrl: bookingData.returnUrl || `${process.env.BASE_URL}/api/payment/vnpay/return`,
        vnp_Locale: VnpLocale.VN,
      };

      const vnpUrl = this.vnpay.buildPaymentUrl(vnpParams);
      console.log('✅ VNPay URL created:', {
        code: bookingData.code,
        amount: bookingData.totalPrice,
        url: vnpUrl
      });
      return vnpUrl;
    } catch (error) {
      console.error('❌ Error creating VNPay URL:', error);
      throw error;
    }
  }

  /**
   * Verify VNPay return/callback
   * @param {Object} vnpParams - Query parameters from VNPay
   * @returns {Object} { ok: boolean, data?: Object }
   */
  verifyReturnUrl(vnpParams) {
    try {
      const isValid = this.vnpay.verifyPaymentUrl(vnpParams);
      console.log('🔔 VNPay verification:', { isValid });
      return { ok: isValid, data: vnpParams };
    } catch (error) {
      console.error('❌ VNPay verification error:', error);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Extract transaction info from VNPay response
   * @param {Object} vnpParams - Query parameters from VNPay
   * @returns {Object} { code, amount, transactionNo, responseCode }
   */
  extractTransactionInfo(vnpParams) {
    return {
      code: vnpParams.vnp_TxnRef || '',
      amount: Number(vnpParams.vnp_Amount || 0) / 100, // Convert back from 1/100 VND
      transactionNo: vnpParams.vnp_TransactionNo || '',
      responseCode: vnpParams.vnp_ResponseCode || '',
      message: vnpParams.vnp_Message || '',
      createDate: vnpParams.vnp_CreateDate || ''
    };
  }
}

export default new PaymentService();