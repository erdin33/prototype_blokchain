// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIssuerRegistry {
    function isActive(address issuer) external view returns (bool);
}

/// @title CredentialRegistry
/// @notice Registri kredensial (Tabel 18 dan 19). Hanya menyimpan cid acak, komitmen (Merkle root
///         atribut bersalt), penerbit, waktu, dan status. Tidak ada data pribadi.
///
///         State transition (Tabel 19):
///           NONE   --issue-->      VALID
///           VALID  --revoke-->     REVOKED      (final)
///           VALID  --supersede-->  SUPERSEDED   (final), kredensial baru VALID
contract CredentialRegistry {
    enum Status { NONE, VALID, REVOKED, SUPERSEDED }

    struct Credential {
        bytes32 commitment;
        address issuer;
        uint64 timestamp;
        Status status;
        bytes32 newCid; // terisi bila SUPERSEDED
    }

    address public immutable governance;
    IIssuerRegistry public issuerRegistry;

    mapping(bytes32 => Credential) private creds;

    event CredentialIssued(bytes32 indexed cid, address indexed issuer);
    event CredentialRevoked(bytes32 indexed cid, uint16 reasonCode);
    event CredentialSuperseded(bytes32 indexed cid, bytes32 indexed newCid);
    event IssuerRegistryChanged(address indexed newRegistry);

    error OnlyGovernance();
    error IssuerNotActive();
    error CidAlreadyUsed();
    error NotOriginalIssuer();
    error NotValid();
    error InvalidInput();

    constructor(address _governance, address _issuerRegistry) {
        require(_governance != address(0) && _issuerRegistry != address(0), "alamat nol");
        governance = _governance;
        issuerRegistry = IIssuerRegistry(_issuerRegistry);
    }

    function issue(bytes32 cid, bytes32 commitment) external {
        if (cid == bytes32(0) || commitment == bytes32(0)) revert InvalidInput();
        if (!issuerRegistry.isActive(msg.sender)) revert IssuerNotActive();
        if (creds[cid].status != Status.NONE) revert CidAlreadyUsed();
        creds[cid] = Credential(commitment, msg.sender, uint64(block.timestamp), Status.VALID, bytes32(0));
        emit CredentialIssued(cid, msg.sender);
    }

    /// @param reasonCode kode alasan (mis. 1 = salah data, 2 = dibatalkan). Bukan teks bebas, agar tanpa PII.
    function revoke(bytes32 cid, uint16 reasonCode) external {
        Credential storage c = _ownedValid(cid);
        c.status = Status.REVOKED;
        emit CredentialRevoked(cid, reasonCode);
    }

    function supersede(bytes32 cid, bytes32 newCid, bytes32 newCommitment) external {
        if (newCid == bytes32(0) || newCommitment == bytes32(0) || newCid == cid) revert InvalidInput();
        Credential storage c = _ownedValid(cid);
        if (creds[newCid].status != Status.NONE) revert CidAlreadyUsed();
        c.status = Status.SUPERSEDED;
        c.newCid = newCid;
        creds[newCid] = Credential(newCommitment, msg.sender, uint64(block.timestamp), Status.VALID, bytes32(0));
        emit CredentialSuperseded(cid, newCid);
    }

    /// @notice Panggilan baca (view): tanpa gas bagi verifier.
    function getStatus(bytes32 cid)
        external
        view
        returns (Status status, bytes32 commitment, address issuer, uint64 timestamp, bytes32 newCid)
    {
        Credential storage c = creds[cid];
        return (c.status, c.commitment, c.issuer, c.timestamp, c.newCid);
    }

    /// @notice Stand-in untuk upgrade kontrak: hanya lewat Governance (proposal ber-time-lock).
    /// @dev Prototipe tidak memakai proxy. Di produksi, gunakan pola proxy dengan admin = Governance.
    function setIssuerRegistry(address newRegistry) external {
        if (msg.sender != governance) revert OnlyGovernance();
        require(newRegistry != address(0), "alamat nol");
        issuerRegistry = IIssuerRegistry(newRegistry);
        emit IssuerRegistryChanged(newRegistry);
    }

    function _ownedValid(bytes32 cid) private view returns (Credential storage c) {
        c = creds[cid];
        if (c.issuer != msg.sender) revert NotOriginalIssuer(); // juga menolak cid yang tidak ada
        if (!issuerRegistry.isActive(msg.sender)) revert IssuerNotActive();
        if (c.status != Status.VALID) revert NotValid(); // REVOKED/SUPERSEDED final
    }
}
