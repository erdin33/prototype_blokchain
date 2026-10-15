# Prototipe Verifikasi Kredensial Akademik (Konsorsium Permissioned, QBFT)

Prototipe untuk P5 (Prototipe dan pengujian). Mengikuti Gambar 2-3 dan Tabel 17-19. Data seluruhnya fiktif.

## Struktur

```
contracts/
  Governance.sol          dewan konsorsium: 1 anggota 1 suara, >= 2/3, time-lock untuk upgrade
  IssuerRegistry.sol      registri penerbit (ACTIVE/SUSPENDED/REMOVED), guardian hanya bisa suspend
  CredentialRegistry.sol  registri kredensial: NONE -> VALID -> REVOKED / SUPERSEDED (final), Tabel 19
offchain/
  merkle.js               Merkle atas atribut bersalt (pengungkapan selektif)
  credential.js           Issuer, Holder, Verifier (Gambar 3 langkah 1-8)
  gateway.js              observer/API gateway baca-saja + rate limit (in-process dan REST)
test/
  functional.test.js      F-01 .. F-11
  security.test.js        S-01 .. S-14
  performance.test.js     P-03 .. P-06
scripts/
  demo.js                 demo alur penerbitan -> verifikasi -> pencabutan
  bench.js                P-01 dan P-02 (bermakna di jaringan Besu)
besu/README.md            S-09, S-10, P-01, P-02, P-07 di jaringan QBFT 4 validator
```

## Menjalankan

```bash
npm install
npm test            # 27 lulus, 2 pending (butuh Besu)
npm run demo
```

Kompilasi memakai paket npm `solc` (solcjs), jadi tidak perlu mengunduh kompiler. Bila akses internet normal
dan ingin kompilasi lebih cepat: `SOLCJS=0 npx hardhat compile`.

## Cara kerja singkat

- Komitmen on-chain = Merkle root atas atribut bersalt: `leaf = H(0x00 || salt || nama || nilai)`.
- Penerbit menandatangani `(alamat registri, cid, root)`. Verifier memulihkan alamat penandatangan dan
  mencocokkannya dengan penerbit yang tercatat on-chain untuk cid itu.
- Atribut `holder` (alamat kunci holder) selalu menjadi daun di dalam root dan selalu diungkap. Verifier memakainya
  untuk memastikan tanda tangan nonce berasal dari pemilik sah (S-06). Ini menjawab pertanyaan
  "dari mana verifier tahu kunci holder" yang di pseudocode P5 belum eksplisit.
- Status dibaca lewat `getStatus` (eth_call, tanpa gas). Gateway tidak punya signer dan metode non-GET ditolak.

## Pemetaan ke kriteria penerimaan

| Kriteria | Cara dibuktikan |
|---|---|
| F-01..F-11 lulus, transisi sesuai Tabel 19 | `test/functional.test.js` |
| S-01..S-14 lulus, tidak ada data pribadi di ledger | `test/security.test.js` (S-08 memindai semua blok) |
| f = 1 berfungsi, melebihi f berhenti aman | **hanya di Besu**: `besu/README.md` |
| P-01..P-05 | P-03..P-05 di `performance.test.js`; P-01, P-02 lewat `scripts/bench.js` di Besu |
| Pengungkapan selektif | F-04, P-06 |
| Keputusan tata kelola jadi event on-chain | F-08 |

## Keterbatasan prototipe

- Jaringan uji Hardhat adalah satu node. Perilaku konsensus QBFT (S-09, S-10, P-01, P-02, P-07) tidak teruji di sana.
- Kunci penerbit dipegang `Wallet` biasa. Di produksi kunci berada di HSM.
- `setIssuerRegistry` adalah pengganti upgrade kontrak. Prototipe tidak memakai proxy.
- Penerbit yang ditangguhkan atau dihapus tidak bisa mencabut kredensial lama miliknya (`revoke` mensyaratkan penerbit aktif).
  Ini sengaja, karena kunci yang bocor tidak boleh dipakai lagi. Konsekuensinya, pencabutan kredensial lama
  setelah offboarding harus lewat penerbit pengganti atau keputusan konsorsium (sesuai P2).
- Nonce tidak dilacak server verifier. Setiap sesi verifikasi harus membuat nonce baru lewat `challenge()`.
