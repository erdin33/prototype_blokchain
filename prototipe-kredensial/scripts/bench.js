// Pengukuran P-01 (latensi finalitas) dan P-02 (throughput penerbitan).
// Bermakna di jaringan QBFT (Besu); di jaringan Hardhat angkanya hanya contoh karena automine.
//   npx hardhat run scripts/bench.js --network besu
// Butuh 10 akun (BESU_KEYS) karena memakai fixture yang sama dengan test.
const { ethers, network } = require("hardhat");
const { deployWithIssuerA } = require("../test/helpers");
const { randomId } = require("../offchain/credential");

const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)];
const N_LATENSI = Number(process.env.N_LATENSI || 100);
const N_BATCH = Number(process.env.N_BATCH || 1000);

async function main() {
  console.log(`Jaringan: ${network.name}`);
  const env = await deployWithIssuerA();
  const reg = env.credReg.connect(env.uniA);

  // P-01: kirim satu per satu, ukur waktu sampai transaksi masuk blok (final di QBFT).
  const lat = [];
  for (let i = 0; i < N_LATENSI; i++) {
    const t = performance.now();
    await (await reg.issue(randomId(), randomId())).wait();
    lat.push(performance.now() - t);
  }
  console.log(`P-01 latensi issue (${N_LATENSI} tx berurutan): median ${pct(lat, 50).toFixed(0)} ms, p95 ${pct(lat, 95).toFixed(0)} ms, maks ${Math.max(...lat).toFixed(0)} ms`);

  // P-02: wisuda massal, kirim N transaksi sekaligus dengan nonce berurutan, tunggu semuanya masuk.
  const nonce0 = await ethers.provider.getTransactionCount(env.uniA.address, "pending");
  const t0 = performance.now();
  const txs = [];
  for (let i = 0; i < N_BATCH; i++) txs.push(await reg.issue(randomId(), randomId(), { nonce: nonce0 + i }));
  const receipts = await Promise.all(txs.map((t) => t.wait()));
  const dt = (performance.now() - t0) / 1000;
  const gagal = receipts.filter((r) => r.status !== 1).length;
  console.log(`P-02 throughput: ${N_BATCH} kredensial dalam ${dt.toFixed(1)} dtk = ${(N_BATCH / dt).toFixed(1)} tx/dtk, gagal/hilang: ${gagal}`);
  console.log(`      target: >= 20 tx/dtk tanpa transaksi hilang`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
