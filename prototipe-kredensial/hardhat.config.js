require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Secara default Hardhat mengunduh kompiler solc dari binaries.soliditylang.org.
// Agar bisa berjalan di lingkungan tanpa akses ke situs itu, kompilasi memakai paket npm `solc` (solcjs).
// Set SOLCJS=0 untuk memakai unduhan bawaan Hardhat (lebih cepat).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (process.env.SOLCJS !== "0" && args.solcVersion === "0.8.24") {
    const solc = require("solc");
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version(),
    };
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Jaringan uji Hyperledger Besu QBFT (lihat README). Isi BESU_RPC dan BESU_KEYS bila dipakai.
    besu: {
      url: process.env.BESU_RPC || "http://127.0.0.1:8545",
      accounts: process.env.BESU_KEYS ? process.env.BESU_KEYS.split(",") : [],
    },
  },
};
