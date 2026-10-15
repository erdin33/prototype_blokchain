const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployWithIssuerA, DATA_LULUSAN } = require("./helpers");
const { Holder, randomId } = require("../offchain/credential");

// Catatan: jaringan Hardhat adalah satu node dengan automine, jadi P-01 dan P-02 (finalitas dan
// throughput QBFT) TIDAK diukur di sini. Keduanya diukur oleh scripts/bench.js di jaringan Besu.
// P-07 (pemulihan node) juga hanya bisa diuji di Besu. Di sini diukur hal yang tidak bergantung konsensus.

const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)];
const LIMIT_BEBAS = { max: 1e9, windowMs: 1000 };

describe("Performa (P-03 s.d. P-06; P-01, P-02, P-07 di Besu)", function () {
  this.timeout(120_000);

  it("P-03 latensi verifikasi: median <= 200 ms, p95 <= 500 ms (1000 panggilan getStatus)", async () => {
    const env = await deployWithIssuerA({ gatewayLimit: LIMIT_BEBAS });
    const pkg = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    const waktu = [];
    for (let i = 0; i < 1000; i++) {
      const t = performance.now();
      await env.gateway.getStatus(pkg.vc.cid);
      waktu.push(performance.now() - t);
    }
    const median = pct(waktu, 50), p95 = pct(waktu, 95);
    console.log(`      median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (node lokal, tanpa latensi jaringan)`);
    expect(median).to.be.at.most(200);
    expect(p95).to.be.at.most(500);
  });

  it("P-04 100 verifier paralel: tanpa galat dan hasil benar semua", async () => {
    const env = await deployWithIssuerA({ gatewayLimit: LIMIT_BEBAS });
    const kasus = [];
    for (let i = 0; i < 100; i++) {
      const pkg = await env.issuerA.issue({ ...DATA_LULUSAN, nim: String(2210511000 + i) }, env.holderW.address);
      env.holder.save(pkg);
      kasus.push(pkg.vc.cid);
    }
    // 10 di antaranya dicabut
    for (const cid of kasus.slice(0, 10)) await env.issuerA.revoke(cid, 2);

    // (a) Beban pada gateway: 100 pemanggil paralel. Inilah yang dilayani server, jadi targetnya P-03.
    const lat = await Promise.all(
      kasus.map(async (cid) => {
        const s = performance.now();
        await env.gateway.getStatus(cid);
        return performance.now() - s;
      })
    );
    console.log(`      gateway, 100 paralel: median ${pct(lat, 50).toFixed(1)} ms, p95 ${pct(lat, 95).toFixed(1)} ms`);
    expect(pct(lat, 50)).to.be.at.most(200);
    expect(pct(lat, 95)).to.be.at.most(500);

    // (b) Kebenaran hasil: 100 verifikasi lengkap sekaligus (tanda tangan + Merkle + status).
    // Semuanya berjalan di SATU thread JS, sehingga waktu antre CPU ikut terhitung. Di dunia nyata
    // tiap verifier punya perangkat sendiri. Karena itu angka ini hanya dilaporkan, tidak dijadikan batas.
    const t = performance.now();
    const hasil = await Promise.all(
      kasus.map(async (cid) => {
        const nonce = env.verifier.challenge();
        const p = await env.holder.present(cid, ["gelar", "tahunLulus"], nonce);
        return env.verifier.verify(p, nonce);
      })
    );
    const total = performance.now() - t;
    console.log(`      100 verifikasi lengkap dalam satu proses: ${total.toFixed(0)} ms total (~${(100000 / total).toFixed(0)} verifikasi/dtk)`);
    expect(hasil.filter((r) => r.result === "VALID")).to.have.length(90);
    expect(hasil.filter((r) => r.result === "REVOKED")).to.have.length(10);
  });

  it("P-05 biaya per verifikasi: tanpa gas (eth_call), saldo verifier tidak berubah", async () => {
    const env = await deployWithIssuerA({ gatewayLimit: LIMIT_BEBAS });
    const pkg = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    const verifierAddr = env.outsider.address;
    const sebelum = await ethers.provider.getBalance(verifierAddr);
    const blokSebelum = await ethers.provider.getBlockNumber();
    for (let i = 0; i < 50; i++) await env.gateway.getStatus(pkg.vc.cid);
    expect(await ethers.provider.getBalance(verifierAddr)).to.equal(sebelum);
    expect(await ethers.provider.getBlockNumber()).to.equal(blokSebelum); // tidak ada transaksi/blok baru
  });

  it("P-06 ukuran bukti Merkle tumbuh logaritmik dan < 1 KB (8, 16, 32 atribut)", async () => {
    const env = await deployWithIssuerA();
    const ukuran = {};
    for (const n of [8, 16, 32]) {
      const attrs = Object.fromEntries(Array.from({ length: n - 1 }, (_, i) => [`atribut${String(i).padStart(2, "0")}`, `nilai-${i}`])); // +1 atribut "holder" = n
      const pkg = await env.issuerA.issue(attrs, env.holderW.address);
      const h = new Holder({ wallet: env.holderW });
      h.save(pkg);
      const p = await h.present(pkg.vc.cid, ["atribut00"], env.verifier.challenge());
      const d = p.disclosed.find((x) => x.name === "atribut00");
      expect(d.proof.siblings).to.have.length(Math.log2(n));
      ukuran[n] = Buffer.byteLength(JSON.stringify(d.proof));
      expect(ukuran[n]).to.be.lessThan(1024);
    }
    console.log("      ukuran bukti (byte JSON):", ukuran);
    expect(ukuran[16]).to.be.lessThan(ukuran[8] * 2);
    expect(ukuran[32]).to.be.lessThan(ukuran[16] * 2);
  });

  it("P-01, P-02, P-07 finalitas, throughput, pemulihan node: diukur di Besu", function () {
    this.skip(); // jalankan: npx hardhat run scripts/bench.js --network besu
  });
});
