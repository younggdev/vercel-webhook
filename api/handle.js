export default async function handler(req, res) {
    // 1. Validasi Method (Webhook biasanya mengirimkan data lewat POST)
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Harus pakai POST request!' });
    }

    try {
        // 2. Ambil data yang dikirim oleh webhook pengirim
        const body = req.body;

        // Log ini akan muncul di dashboard Vercel kamu nanti untuk debugging
        console.log('--- Ada Webhook Masuk ---');
        console.log('Data:', JSON.stringify(body, null, 2));

        // 3. (Opsional) Kerjakan logika kamu di sini
        // Contoh: const pesan = body.message;

        // 4. Kirim respon balik dengan cepat (Wajib agar tidak timeout)
        return res.status(200).json({
            success: true,
            message: 'Webhook berhasil diterima oleh Vercel!',
            received_data: body
        });

    } catch (error) {
        console.error('Error handling webhook:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}