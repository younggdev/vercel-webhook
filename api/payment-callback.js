import crypto from 'crypto';
import querystring from 'querystring';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export const config = {
    api: {
        bodyParser: false, // Kita handle pembacaan data secara manual agar lebih akurat
    },
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Gunakan service role key agar bypass RLS pada callback backend
const supabaseCreateClient = createClient(supabaseUrl, supabaseKey);
const DIGI_USER = process.env.DIGIFLAZ_USERNAME;
const DIGI_KEY = process.env.DIGIFLAZ_API_KEY;

// Helper untuk mengambil raw body
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

// Helper untuk memparsing data form-data sederhana tanpa library eksternal
function parseMultipartFormData(rawBodyStr, contentTypeHeader) {
    const boundaryMatch = contentTypeHeader.match(/boundary=(.+)/);
    if (!boundaryMatch) return {};

    const boundary = boundaryMatch[1];
    const parts = rawBodyStr.split('--' + boundary);
    const result = {};

    for (const part of parts) {
        if (part.includes('name=')) {
            const nameMatch = part.match(/name="([^"]+)"/);
            if (nameMatch) {
                const key = nameMatch[1];
                // Ambil nilai setelah baris kosong (\r\n\r\n) sampai sebelum baris baru terakhir
                const valueStr = part.split(/\r?\n\r?\n/)[1];
                if (valueStr) {
                    result[key] = valueStr.replace(/\r?\n(--)?$/, '').trim();
                }
            }
        }
    }
    return result;
}

// Fungsi untuk mengirim pesan ke Telegram menggunakan fetch bawaan
async function kirimNotifikasiTelegram(chatId, pesan) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: pesan,
                parse_mode: 'Markdown' // Agar Anda bisa pakai format bold/italic di teks
            })
        });

        const result = await response.json();
        if (result.ok) {
            console.log('Notifikasi Telegram berhasil dikirim!');
        } else {
            console.error('Gagal kirim Telegram:', result.description);
        }
    } catch (error) {
        console.error('Error saat fetch ke Telegram API:', error);
    }
}

function generateSign(username, apiKey, refId) {
    return crypto
        .createHash('md5')
        .update(username + apiKey + refId)
        .digest('hex');
}

async function placeOrder(sku, customerNo, refId) {
    const sign = generateSign(DIGI_USER, DIGI_KEY, refId);

    console.log(`--- Melakukan Order ---`);
    console.log(`SKU: ${sku} | Target: ${customerNo} | RefID: ${refId}`);
    try {
        const response = await axios.post('https://api.digiflazz.com/v1/transaction', {
            username: DIGI_USER,
            buyer_sku_code: sku,
            customer_no: customerNo,
            ref_id: refId,
            sign: sign
        });
        console.log("Respon Digiflazz:", response.data);
        return response.data.data;
    } catch (error) {
        console.error('Digiflazz Error:', error.response?.data || error.message);
        return null;
    }
}

// === TEMPATKAN DI DALAM LOGIKA CALLBACK ANDA ===

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const apiKey = process.env.SAKURUPIAH_API_KEY;

    try {
        // 1. Ambil data mentah dari stream
        const rawBodyBuffer = await getRawBody(req);
        const rawBodyString = rawBodyBuffer.toString('utf-8');

        // 2. Deteksi Content-Type dan Parsing secara cerdas
        let bodyData = {};
        const contentType = req.headers['content-type'] || '';

        if (contentType.includes('application/json')) {
            try {
                bodyData = JSON.parse(rawBodyString);
            } catch (e) {
                bodyData = querystring.parse(rawBodyString);
            }
        } else if (contentType.includes('multipart/form-data')) {
            // Panggil fungsi parser khusus form-data di atas
            bodyData = parseMultipartFormData(rawBodyString, contentType);
        } else {
            // Default ke x-www-form-urlencoded
            bodyData = querystring.parse(rawBodyString);
        }

        // 3. Ambil headers untuk validasi
        const callbackSignature = req.headers['x-callback-signature'] || '';
        const callbackEvent = req.headers['x-callback-event'] || '';

        // Ambil parameter data callback
        const payment_Status = bodyData.status ? bodyData.status.toLowerCase() : '';
        const payment_StatusKode = bodyData.status_kode ? parseInt(bodyData.status_kode) : NaN;
        const payment_TrxID = bodyData.trx_id || '';
        const payment_MerchantRef = bodyData.merchant_ref || '';

        // Log untuk melihat hasil parsing di Vercel Dashboard kamu
        console.log(`[Parsed Data] Status: "${payment_Status}", Kode: ${payment_StatusKode}, Trx: ${payment_TrxID}`);
        console.log(bodyData);


        // 4. Percabangan Logika Status Pembayaran
        if (payment_Status === "berhasil" || payment_StatusKode === 1 || payment_StatusKode === '1') {

            // [LOGIKAMU] Tempatkan proses sukses di sini (Kirim bot Telegram / Digiflaz)
            console.log("👉 SUKSES: Memproses transaksi berhasil.");

            const { data: user, error: selectError } = await supabaseCreateClient
                .from('transactions')
                .select('*')
                .eq('order_id', payment_MerchantRef)
                .single();

            console.log(user);


            const sku_code = user.sku;
            const targetId = user.target_id;
            const refId = payment_MerchantRef;
            console.log(`[Memori Terkunci] Mengamankan SKU: ${sku_code} | Target: ${targetId}`);

            if (user.status_pay === 'Berhasil') {
                console.log("⚠️ Transaksi ini sudah sukses diproses sebelumnya. Blokir penembakan ulang.");
                return res.status(200).json({ success: true, message: 'Already processed' });
            }

            const { error: supabaseError } = await supabaseCreateClient
                .from('transactions')
                .update({ status_pay: 'Berhasil' }) // ✅ PERBAIKAN: Gunakan {} bukan []
                .eq('order_id', payment_MerchantRef);

            const result = await placeOrder(sku_code, targetId, refId);
            // const result = "berhasil";

            let statusTopup = "Sedang diproses";
            let teksPesan = ''
            if (result && result.status === 'Gagal') {
                statusTopup = `Gagal (${resultDigi.sn})`;
                // Kembalikan status di database menjadi butuh tindakan admin/refund
                await supabaseCreateClient
                    .from('transactions')
                    .update({ status_pay: 'Gagal (Butuh Refund)' })
                    .eq('order_id', payment_MerchantRef);

                teksPesan = `❌ *PEMBAYARAN DITERIMA, TAPI TOP-UP GAGAL*\n\n` +
                    `Halo, pembayaran Anda untuk Order ID \`${payment_MerchantRef}\` telah kami terima.\n\n` +
                    `Namun, produk sedang mengalami gangguan sistem/stok habis dengan alasan: *${result.sn || 'Provider Gangguan'}*.\n\n` +
                    `🚨 *Mengenai Dana Anda:*\n` +
                    `Jangan khawatir, data transaksi Anda sudah tercatat di sistem kami. *Akan kami lakukan refund secepatnya* ke rekening/e-wallet Anda.\n\n` +
                    `Silakan hubungi Customer Service / Admin dengan mengirimkan bukti screenshot pesan ini untuk mempercepat proses klaim. Terima kasih atas pengertiannya.`;
            } else {
                teksPesan = `✅ *PEMBAYARAN BERHASIL DITERIMA!*\n\n` +
                    `📌 *Detail Transaksi:*\n` +
                    `• ID Pesanan: \`${payment_MerchantRef}\`\n` +
                    `• Produk: *${sku_code}*\n` +
                    `• Tujuan: \`${targetId}\`\n\n` +
                    `⚡ *Status Top-Up:* \`${statusTopup}\`\n\n` +
                    `Terima kasih telah memercayakan Yodev Zone! Pesanan Anda diantrekan otomatis oleh sistem.`;
            }

            const targetChatId = user.chat_id;
            // 2. Panggil fungsinya untuk kirim ke user
            await kirimNotifikasiTelegram(targetChatId, teksPesan);

            return res.status(200).json({ success: true, message: 'Payment status berhasil' });

        } else if (payment_Status === "expired" || payment_StatusKode === 2 || payment_StatusKode === -2) {

            console.log("👉 EXPIRED: Memproses transaksi kedaluwarsa.");
            return res.status(200).json({ success: true, message: 'Payment status expired' });

        } else if (payment_Status === "pending" || payment_StatusKode === 0) {

            console.log("👉 PENDING: Transaksi menunggu pembayaran.");
            return res.status(200).json({ success: true, message: 'Payment status pending' });

        } else {
            // Jika data masih gagal di-parsing / kosong
            return res.status(400).json({
                success: false,
                message: `Status tidak dikenali. Diterima status: "${payment_Status}" dengan kode: ${payment_StatusKode}`,
                debug_raw_body: rawBodyString // Membantu kamu melihat isi data asli yang masuk saat tes
            });
        }

    } catch (error) {
        console.error('Webhook Error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
}
