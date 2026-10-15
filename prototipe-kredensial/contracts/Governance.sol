// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Governance
/// @notice Dewan konsorsium: 1 anggota 1 suara, keputusan sah bila suara setuju >= 2/3 anggota.
///         Proposal berisi panggilan ke kontrak lain (mis. IssuerRegistry.addIssuer).
///         Proposal bertanda `timelocked` (mis. upgrade kontrak) baru boleh dieksekusi
///         setelah jeda `timelockDelay` sejak disetujui.
/// @dev Prototipe. Anggota dewan = operator validator, ditetapkan saat deploy.
///      Semua tahapan memancarkan event sebagai jejak audit (tanpa data pribadi).
contract Governance {
    struct Proposal {
        address target;
        bytes data;
        bool timelocked;
        uint64 approvedAt; // 0 = belum disetujui
        uint32 yes;
        bool executed;
    }

    address[] public members;
    mapping(address => bool) public isMember;
    uint64 public immutable timelockDelay;

    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) private voted;

    event ProposalCreated(uint256 indexed id, address indexed proposer, address target, bool timelocked);
    event Voted(uint256 indexed id, address indexed member, uint32 yesVotes);
    event ProposalApproved(uint256 indexed id, uint64 approvedAt);
    event ProposalExecuted(uint256 indexed id);

    error NotMember();
    error AlreadyVoted();
    error NotApproved();
    error TimelockActive(uint64 executableAt);
    error AlreadyExecuted();
    error CallFailed();

    modifier onlyMember() {
        if (!isMember[msg.sender]) revert NotMember();
        _;
    }

    constructor(address[] memory _members, uint64 _timelockDelay) {
        require(_members.length >= 4, "min 4 anggota (n >= 3f+1, f=1)");
        for (uint256 i = 0; i < _members.length; i++) {
            require(!isMember[_members[i]] && _members[i] != address(0), "anggota tidak valid");
            isMember[_members[i]] = true;
            members.push(_members[i]);
        }
        timelockDelay = _timelockDelay;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    /// @notice Jumlah suara minimum: ceil(2n/3).
    function threshold() public view returns (uint256) {
        return (members.length * 2 + 2) / 3;
    }

    function propose(address target, bytes calldata data, bool timelocked) external onlyMember returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal(target, data, timelocked, 0, 0, false));
        emit ProposalCreated(id, msg.sender, target, timelocked);
    }

    /// @notice Beri suara setuju. Bila ambang tercapai dan tidak ada time-lock, langsung dieksekusi.
    function vote(uint256 id) external onlyMember {
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (voted[id][msg.sender]) revert AlreadyVoted();
        voted[id][msg.sender] = true;
        p.yes += 1;
        emit Voted(id, msg.sender, p.yes);

        if (p.approvedAt == 0 && p.yes >= threshold()) {
            p.approvedAt = uint64(block.timestamp);
            emit ProposalApproved(id, p.approvedAt);
            if (!p.timelocked) _execute(id, p);
        }
    }

    /// @notice Eksekusi proposal ber-time-lock setelah jeda terlewati.
    function execute(uint256 id) external onlyMember {
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.approvedAt == 0) revert NotApproved();
        uint64 executableAt = p.approvedAt + (p.timelocked ? timelockDelay : 0);
        if (block.timestamp < executableAt) revert TimelockActive(executableAt);
        _execute(id, p);
    }

    function getProposal(uint256 id)
        external
        view
        returns (address target, bool timelocked, uint64 approvedAt, uint32 yes, bool executed)
    {
        Proposal storage p = proposals[id];
        return (p.target, p.timelocked, p.approvedAt, p.yes, p.executed);
    }

    function _execute(uint256 id, Proposal storage p) private {
        p.executed = true; // set sebelum call (cegah reentrancy)
        (bool ok,) = p.target.call(p.data);
        if (!ok) revert CallFailed();
        emit ProposalExecuted(id);
    }
}
