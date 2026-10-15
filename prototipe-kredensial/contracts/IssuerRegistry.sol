// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IssuerRegistry
/// @notice Registri penerbit (Tabel 18): DID, alamat penandatangan, dan status.
///         Penambahan/penghapusan hanya lewat tata kelola (>= 2/3 suara).
///         Guardian hanya boleh menangguhkan; tidak bisa menerbitkan atau mencabut kredensial.
contract IssuerRegistry {
    enum IssuerStatus { NONE, ACTIVE, SUSPENDED, REMOVED }

    struct Issuer {
        string did;
        IssuerStatus status;
    }

    address public immutable governance; // kontrak Governance
    address public immutable guardian;

    mapping(address => Issuer) private issuers;

    event IssuerAdded(address indexed issuer, string did);
    event IssuerRemoved(address indexed issuer);
    event IssuerSuspended(address indexed issuer, address indexed by);
    event IssuerReinstated(address indexed issuer);

    error OnlyGovernance();
    error OnlyGuardian();
    error InvalidState();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    constructor(address _governance, address _guardian) {
        require(_governance != address(0) && _guardian != address(0), "alamat nol");
        governance = _governance;
        guardian = _guardian;
    }

    function addIssuer(address issuer, string calldata did) external onlyGovernance {
        if (issuers[issuer].status != IssuerStatus.NONE) revert InvalidState();
        require(issuer != address(0) && bytes(did).length > 0, "data tidak valid");
        issuers[issuer] = Issuer(did, IssuerStatus.ACTIVE);
        emit IssuerAdded(issuer, did);
    }

    /// @notice Offboarding / kunci bocor. Kredensial lama tetap bisa diverifikasi (riwayat tidak dihapus).
    function removeIssuer(address issuer) external onlyGovernance {
        IssuerStatus s = issuers[issuer].status;
        if (s != IssuerStatus.ACTIVE && s != IssuerStatus.SUSPENDED) revert InvalidState();
        issuers[issuer].status = IssuerStatus.REMOVED;
        emit IssuerRemoved(issuer);
    }

    /// @notice Pulihkan penerbit yang ditangguhkan, setelah ditinjau dewan.
    function reinstate(address issuer) external onlyGovernance {
        if (issuers[issuer].status != IssuerStatus.SUSPENDED) revert InvalidState();
        issuers[issuer].status = IssuerStatus.ACTIVE;
        emit IssuerReinstated(issuer);
    }

    /// @notice Penangguhan darurat. Satu-satunya hak guardian.
    function suspend(address issuer) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        if (issuers[issuer].status != IssuerStatus.ACTIVE) revert InvalidState();
        issuers[issuer].status = IssuerStatus.SUSPENDED;
        emit IssuerSuspended(issuer, msg.sender);
    }

    function isActive(address issuer) external view returns (bool) {
        return issuers[issuer].status == IssuerStatus.ACTIVE;
    }

    function getIssuer(address issuer) external view returns (string memory did, IssuerStatus status) {
        Issuer storage i = issuers[issuer];
        return (i.did, i.status);
    }
}
