import paymentService from "../services/paymentService.js";
import { Booking } from "../models/Booking.js";
import { Tour } from "../models/Tour.js";
import { sendMail } from "../services/mailer.js";
import { notifyTourConfirmed } from "../services/notify.js";
import mongoose from "mongoose";

async function markDepositAndMaybeConfirm(booking, amount) {
  const wasDepositPaid = Boolean(booking.depositPaid);
  const isFirstDeposit = !wasDepositPaid && Number(amount) > 0;
  
  booking.paidAmount = (booking.paidAmount || 0) + Number(amount || 0);
  
  if (isFirstDeposit) {
    booking.depositPaid = true;
  }
  
  if ((booking.paidAmount || 0) >= (booking.totalPrice || Number.MAX_SAFE_INTEGER)) {
    booking.bookingStatus = "c";
  }
  
  await booking.save();

  // Gửi email thông báo
  if (isFirstDeposit && booking.email) {
    try {
      await sendMail({
        to: booking.email,
        subject: `Đã nhận tiền cọc - ${booking.code}`,
        html: `
          <p>Xin chào ${booking.fullName || "Quý khách"},</p>
          <p>Chúng tôi đã nhận tiền cọc cho đơn <b>${booking.code}</b> với số tiền <b>${Number(amount).toLocaleString()} VND</b>.</p>
          <p>Tổng giá: <b>${(booking.totalPrice||0).toLocaleString()} VND</b> — Đã trả: <b>${(booking.paidAmount||0).toLocaleString()} VND</b>.</p>
          <p>Chúng tôi sẽ thông báo ngay khi tour xác nhận khởi hành.</p>
        `
      });
    } catch (e) {
      console.error("Send deposit mail error:", e);
    }
  } else if (booking.bookingStatus === "c" && booking.email) {
    try {
      await sendMail({
        to: booking.email,
        subject: `Xác nhận thanh toán đủ - ${booking.code}`,
        html: `<p>Đơn <b>${booking.code}</b> đã thanh toán đủ. Hẹn gặp bạn tại tour!</p>`
      });
    } catch (e) {
      console.error("Send fully-paid mail error:", e);
    }
  }

  // Tăng current_guests và kiểm tra xác nhận tour
  if (isFirstDeposit) {
    const guestsToAdd = (booking.numAdults||0) + (booking.numChildren||0);
    const tour = await Tour.findById(booking.tourId);
    
    if (tour) {
      // Kiểm tra còn slot
      if (Number.isFinite(tour.quantity)) {
        if ((tour.current_guests || 0) + guestsToAdd > tour.quantity) {
          console.warn("Tour sold out while paying:", booking.code);
          return booking;
        }
      }
      
      // Tăng số khách hiện tại
      tour.current_guests = (tour.current_guests || 0) + guestsToAdd;
      
      // Kiểm tra đủ khách để xác nhận tour
      if ((tour.current_guests >= (tour.min_guests || 0)) && tour.status !== "confirmed") {
        tour.status = "confirmed";
        await tour.save();
        try {
          await notifyTourConfirmed(tour._id);
        } catch (e) {
          console.error("Notify tour confirmed error:", e);
        }
      } else {
        await tour.save();
      }
    }
  }

  return booking;
}

// Người dùng bị redirect về đây: nên redirect FE sau khi ghi nhận trạng thái
export const vnpReturn = async (req, res) => {
  try {
    const q = req.query;
    const { ok } = paymentService.verifyReturnUrl(q);
    
    console.log("🔔 VNPay return:", { ok, query: q });
    
    if (!ok) {
      // Sai chữ ký → không tin tưởng, chuyển về FE với trạng thái fail
      const redirect = `${process.env.FRONTEND_URL || "http://localhost:3000"}/payment?status=failed&reason=invalid_sig`;
      return res.redirect(redirect);
    }

    const txnInfo = paymentService.extractTransactionInfo(q);
    const code = txnInfo.code.split("-")[0];          // Extract booking code
    const payAmount = txnInfo.amount;
    const transactionNo = txnInfo.transactionNo;
    const rsp = txnInfo.responseCode;

    const booking = await Booking.findOne({ code });
    if (!booking) {
      const redirect = `${process.env.FRONTEND_URL || "http://localhost:3000"}/payment?status=failed&reason=notfound`;
      return res.redirect(redirect);
    }

    if (rsp === "00") {
      // Idempotent: nếu đã ghi nhận ref này thì bỏ qua
      if (!booking.paymentRefs?.some(p => p.provider === "vnpay" && p.ref === transactionNo)) {
        booking.paymentRefs = booking.paymentRefs || [];
        booking.paymentRefs.push({ 
          provider: "vnpay", 
          ref: transactionNo, 
          amount: payAmount, 
          at: new Date() 
        });
        await markDepositAndMaybeConfirm(booking, payAmount);
        console.log("✅ VNPay payment recorded:", { code, amount: payAmount, transactionNo });
      }
      const redirect = `${process.env.FRONTEND_URL || "http://localhost:3000"}/user/bookings?status=success&code=${booking.code}`;
      return res.redirect(redirect);
    } else {
      console.log("❌ VNPay payment failed:", { code, responseCode: rsp });
      const redirect = `${process.env.FRONTEND_URL || "http://localhost:3000"}/user/bookings?status=failed&reason=${rsp}`;
      return res.redirect(redirect);
    }
  } catch (err) {
    console.error("VNPay return error:", err);
    const redirect = `${process.env.FRONTEND_URL || "http://localhost:3000"}/payment/bookings?status=failed&reason=server`;
    return res.redirect(redirect);
  }
};
export const vnpIpn = async (req, res) => {
  try {
    const q = req.query; // VNPAY gọi dạng GET
    const { ok } = paymentService.verifyReturnUrl(q);
    
    console.log("🔔 VNPay IPN:", { ok, query: q });
    
    if (!ok) {
      return res.json({ RspCode: "97", Message: "Invalid signature" });
    }

    const txnInfo = paymentService.extractTransactionInfo(q);
    const code = txnInfo.code.split("-")[0];          // Extract booking code
    const payAmount = txnInfo.amount;
    const transactionNo = txnInfo.transactionNo;
    const rsp = txnInfo.responseCode;

    const booking = await Booking.findOne({ code });
    if (!booking) return res.json({ RspCode: "01", Message: "Order not found" });

    // Idempotent
    if (booking.paymentRefs?.some(p => p.provider === "vnpay" && p.ref === transactionNo)) {
      return res.json({ RspCode: "00", Message: "Already confirmed" });
    }

    if (rsp === "00") {
      booking.paymentRefs = booking.paymentRefs || [];
      booking.paymentRefs.push({ 
        provider: "vnpay", 
        ref: transactionNo, 
        amount: payAmount, 
        at: new Date() 
      });
      await markDepositAndMaybeConfirm(booking, payAmount);
      console.log("✅ VNPay IPN payment recorded:", { code, amount: payAmount, transactionNo });
      return res.json({ RspCode: "00", Message: "Confirm success" });
    } else {
      console.log("❌ VNPay IPN payment failed:", { code, responseCode: rsp });
      return res.json({ RspCode: rsp, Message: "Payment failed" });
    }
  } catch (err) {
    console.error("VNPay IPN error:", err);
    return res.json({ RspCode: "99", Message: "Unknown error" });
  }
};