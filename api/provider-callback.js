import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// 1. Inisialisasi Supabase menggunakan Service Role Key agar bypass RLS di backend
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Token Bot Telegram dari Environment Variable
const BOT_TOKEN = process.env.BOT_TOKEN;

// 3. Secret Key Webhook yang kamu buat/atur di Dashboard Digiflaz
const DIGIFLAZ_WEBHOOK_SECRET = process.env.DIGIFLAZ_SECRET_KEY;

// Konfigurasi Vercel: Matikan bodyParser bawaan agar kita bisa hitung signature dari raw body mentah
export const config = {
    api: {
        bodyParser: false,
    },
};

// Helper untuk membaca stream raw body dari request
async function getRawBody(readable) {
    const chunks = [];
    for await (const chunk of readable) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

// Helper untuk mengirim notifikasi pesan ke Telegram
async function kirimNotifikasiTelegram(chatId, pesan) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: pesan,
                parse_mode: 'Markdown'
            })
        });
        const result = await response.json();
        if (!result.ok) {
            console.error('⚠️ Gagal kirim Telegram:', result.description);
        }
    } catch (error) {
        console.error('❌ Error saat fetch ke Telegram API:', error.message);
    }
}

// Helper untuk format angka ke Rupiah
const formatRupiah = (angka) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);
};

// === MAIN HANDLER VERCEL ===
export default async function handler(req, res) {
    // Batasi hanya menerima method POST
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    try {
        // 1. Ambil data mentah (raw body) untuk validasi hmac-sha1
        const rawBodyBuffer = await getRawBody(req);
        const rawBodyString = rawBodyBuffer.toString('utf-8');

        // 2. Ambil & Validasi X-Hub-Signature dari Digiflaz
        const digiflazSignature = req.headers['x-hub-signature'] || '';
        const expectedSignature = 'sha1=' + crypto
            .createHmac('sha1', DIGIFLAZ_WEBHOOK_SECRET)
            .update(rawBodyString)
            .digest('hex');

        if (digiflazSignature !== expectedSignature) {
            console.error('❌ Signature tidak valid! Request dicurigai palsu.');
            return res.status(403).json({ success: false, message: 'Invalid signature' });
        }

        // 3. Parse data JSON setelah lolos validasi keamanan
        const payload = JSON.parse(rawBodyString);
        const {
            ref_id,
            customer_no,
            buyer_sku_code,
            status,
            sn,
            message,
            price
        } = payload.data;

        console.log(`📩 Callback Digiflaz Masuk -> Ref ID: ${ref_id} | Status: ${status}`);

        // 4. Ambil data transaksi dari Supabase berdasarkan ref_id (atau order_id)
        // Ambil chat_id untuk tahu siapa yang beli
        const { data: txData, error: fetchError } = await supabase
            .from('transactions')
            .select('chat_id, status_prod')
            .eq('order_id', ref_id) // Ganti 'order_id' sesuai nama kolom id transaksimu di DB
            .maybeSingle();

        if (fetchError || !txData) {
            console.error(`⚠️ Data transaksi ${ref_id} tidak ditemukan di database.`);
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const targetChatId = txData.chat_id;

        // Cegah eksekusi ulang jika status di database kamu sudah telanjur sukses/gagal final
        if (txData.status === 'Sukses' || txData.status === 'Gagal') {
            console.log(`ℹ️ Transaksi ${ref_id} sudah diproses sebelumnya dengan status: ${txData.status}`);
            return res.status(200).send('OK');
        }

        // 5. Percabangan Logika berdasarkan Status dari Digiflaz ("Sukses" / "Gagal")
        if (status === 'Sukses') {

            // Update status transaksi di database menjadi 'Sukses' dan simpan SN produk
            await supabase
                .from('transactions')
                .update({
                    status_prod: 'Sukses',
                    sn: sn,
                    updated_at: new Date()
                })
                .eq('order_id', ref_id);

            // Buat template text sukses untuk dikirim ke Telegram user
            const teksSukses = `✅ *TOP-UP BERHASIL PROSES!*\n\n` +
                `📌 *Detail Pesanan:*\n` +
                `• ID Pesanan: \`${ref_id}\`\n` +
                `• Produk: *${buyer_sku_code.toUpperCase()}*\n` +
                `• ID Tujuan: \`${customer_no}\`\n` +
                `⚡ *SN:* \`${sn}\`\n\n` +
                `Terima kasih telah berbelanja di Yodev Zone! Datamu sudah diperbarui.`;

            await kirimNotifikasiTelegram(targetChatId, teksSukses);

        } else if (status === 'Gagal') {

            // Update status transaksi di database menjadi 'Gagal' beserta catatan errornya
            await supabase
                .from('transactions')
                .update({
                    status_prod: 'Gagal',
                    notes: message,
                    updated_at: new Date()
                })
                .eq('order_id', ref_id);

            // Buat template text gagal/refund untuk dikirim ke Telegram user
            const teksGagal = `❌ *TOP-UP GAGAL / REJECTED*\n\n` +
                `Halo, pesanan Anda dengan ID \`${ref_id}\` gagal diproses oleh sistem provider.\n\n` +
                `• *Alasan Gagal:* ${message || 'Stok Kosong / Gangguan Provider'}\n\n` +
                `🚨 *Informasi Dana:*\n` +
                `Jangan khawatir, data transaksi Anda sudah tercatat di sistem kami. *Akan kami lakukan refund secepatnya* ke rekening/e-wallet Anda.\n\n` +
                `Silakan hubungi Customer Service / Admin dengan mengirimkan bukti screenshot pesan ini untuk mempercepat proses klaim. Terima kasih atas pengertiannya.`;

            await kirimNotifikasiTelegram(targetChatId, teksGagal);
        }

        // 6. WAJIB: Kirim balasan 200 OK ke Digiflaz agar sistem mereka tahu data sukses kita terima
        return res.status(200).send('OK');

    } catch (error) {
        console.error('❌ Webhook Handler Error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
}