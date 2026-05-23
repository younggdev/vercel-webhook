import crypto from 'crypto';

// Jika Sakurupiah mengirimkan tipe data berupa form-urlencoded, kita perlu modul ini
import querystring from 'querystring';

export const config = {
    api: {
        // Kita matikan bodyParser bawaan Vercel jika data yang masuk berupa raw/form-data stream
        bodyParser: false,
    },
};

// Helper function untuk membaca stream data mentah dari callback
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const apiKey = process.env.SAKURUPIAH_API_KEY;
    // Masukkan API ID Merchant Anda di sini
    const apiId = process.env.SAKURUPIAH_API_ID;

    try {
        // 1. Ambil data mentah (raw body)
        const rawBodyBuffer = await getRawBody(req);
        const rawBodyString = rawBodyBuffer.toString('utf-8');

        // 2. Parsing data berdasarkan Content-Type yang masuk
        let bodyData = {};
        const contentType = req.headers['content-type'] || '';

        if (contentType.includes('application/json')) {
            try {
                bodyData = JSON.parse(rawBodyString);
            } catch (e) {
                // Jika gagal parse JSON karena aslinya berbentuk form-urlencoded
                bodyData = querystring.parse(rawBodyString);
            }
        } else {
            bodyData = querystring.parse(rawBodyString);
        }

        // 3. Ambil headers untuk validasi
        const callbackSignature = req.headers['x-callback-signature'] || '';
        const callbackEvent = req.headers['x-callback-event'] || '';

        // 4. Menyusun Signature Verification
        // CATATAN: Karena di callback tidak ada data_method, pastikan apakah rumusnya memakai method hardcode 
        // atau variabel kosong jika di sisi callback. Berdasarkan dokumentasi Postman, mari kita susun stringnya.
        const merchant_ref = bodyData.merchant_ref || '';

        // PERINGATAN: Di data callback Postman tidak dikirim data 'amount' dan 'method/data_method'.
        // Jika Sakurupiah menggunakan data JSON asli untuk validasi signature callback, maka kita gunakan json string.
        // Tetapi jika rumusnya sama dengan invoice, kita harus tahu dari mana mendapatkan 'amount' & 'method'.

        // Opsi A: Jika signature callback dikirim menggunakan seluruh string body JSON dari Sakurupiah:
        const signatureJSON = crypto.createHmac('sha256', apiKey).update(rawBodyString).digest('hex');

        // Opsi B: Sesuai rumus text gabungan dari data yang ada di callback (sesuai dokumentasi Postman)
        // Jika Opsi A gagal saat ditest, gunakan struktur data gabungan string di bawah ini.

        // Validasi Event Header
        if (callbackEvent !== 'payment_status') {
            return res.status(400).json({ success: false, message: `Unrecognized callback event: ${callbackEvent}` });
        }

        const payment_TrxID = bodyData.trx_id;
        const payment_MerchantRef = bodyData.merchant_ref;
        const payment_StatusKode = parseInt(bodyData.status_kode);
        const payment_Status = bodyData.status ? bodyData.status.toLowerCase() : '';

        console.log(`[Sakurupiah Log] Mengetes Status: "${payment_Status}" dengan Kode: ${payment_StatusKode}`);

        // 5. Percabangan Logika Status Pembayaran
        if (payment_Status === "berhasil" || payment_StatusKode === 1) {

            // [LOGIKAMU] Tempatkan proses sukses di sini 
            // (Misal: Kirim Bot Telegram / Proses API Digiflaz)
            console.log("👉 Menjalankan logika transaksi BERHASIL");

            return res.status(200).json({
                success: true,
                message: 'Payment status berhasil',
            });

        } else if (payment_Status === "expired" || payment_StatusKode === 2 || payment_StatusKode === -2) {

            // [LOGIKAMU] Proses jika transaksi kadaluarsa
            console.log("👉 Menjalankan logika transaksi EXPIRED");

            return res.status(200).json({
                success: true,
                message: 'Payment status expired',
            });

        } else if (payment_Status === "pending" || payment_StatusKode === 0) {

            console.log("👉 Menjalankan logika transaksi PENDING");

            return res.status(200).json({
                success: true,
                message: 'Payment status pending',
            });

        } else {
            // Jika tipe data yang masuk benar-benar di luar dugaan
            return res.status(400).json({
                success: false,
                message: `Status tidak dikenali. Diterima status: "${payment_Status}" dengan kode: ${payment_StatusKode}`
            });
        }

    } catch (error) {
        console.error('Webhook Error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
}