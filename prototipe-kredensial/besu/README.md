# Pengujian di jaringan Hyperledger Besu (QBFT, 4 validator)

Bagian ini **belum dijalankan** di lingkungan penyusun prototipe (tanpa Docker/Besu). Langkahnya mengikuti
dokumentasi resmi Besu; sesuaikan versi dan flag dengan Besu yang Anda pasang
(lihat "Create a private network using QBFT" di docs.besu.hyperledger.org).

## 1. Membuat jaringan

1. Buat `qbftConfigFile.json` dengan `genesis.config.qbft` (mis. `blockperiodseconds: 2`, `epochlength: 30000`,
   `requesttimeoutseconds: 4`) dan `blockchain.nodes.generate: true`, `count: 4`.
2. `besu operator generate-blockchain-config --config-file=qbftConfigFile.json --to=networkFiles --private-key-file-name=key`
   menghasilkan `genesis.json` dan kunci 4 node.
3. Jalankan 4 node (4 operator berbeda di produksi; 4 kontainer untuk uji), node pertama sebagai bootnode.
   Aktifkan RPC HTTP di satu node (observer) dan set `--min-gas-price=0` agar tidak ada biaya gas.
4. Beri saldo akun uji di `alloc` genesis atau gunakan `--min-gas-price=0`.

## 2. Menjalankan test dan benchmark

```bash
export BESU_RPC=http://127.0.0.1:8545
export BESU_KEYS=0xKUNCI1,...,0xKUNCI10      # 10 akun: 4 anggota dewan, guardian, 2 penerbit, 3 lainnya
npx hardhat test --network besu              # S-13 dan P-xx yang butuh time-travel akan dilewati
npx hardhat run scripts/bench.js --network besu   # P-01, P-02
```

Target: P-01 finalitas <= 2x periode blok; P-02 >= 20 tx/dtk tanpa transaksi hilang.

## 3. S-09 dan S-10 (toleransi node Bizantin)

| Langkah | Hasil yang diharapkan |
|---|---|
| Hentikan 1 dari 4 validator (`docker stop validator4`), jalankan `bench.js` | Blok tetap dihasilkan dan final; transaksi `issue` berhasil (S-09) |
| Hentikan validator ke-2 (tersisa 2 dari 4) | Produksi blok berhenti (`eth_blockNumber` tidak naik); transaksi baru tidak masuk blok dan tidak ada status palsu yang tersahkan (S-10) |
| Nyalakan lagi validator yang dihentikan | Jaringan lanjut; node yang dinyalakan sinkron kembali tanpa kehilangan data (P-07) |

Simpan tangkapan layar `docker ps`, log Besu, dan keluaran `eth_blockNumber` sebelum dan sesudah sebagai bukti.
