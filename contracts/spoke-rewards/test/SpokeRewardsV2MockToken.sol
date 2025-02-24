// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "../../bridge/interfaces/IBridgeRouter.sol";
import "../../bridge/libraries/Messages.sol";
import "../../spoke/interfaces/IAddressOracle.sol";
import "../SpokeRewardsV2Token.sol";

contract SpokeRewardsV2MockToken is SpokeRewardsV2Token {
    event ReceiveToken(uint256 amount);
    event SendToken(address recipient, uint256 amount);

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        uint16 hubChainId,
        bytes32 hubContractAddress,
        IAddressOracle addressOracle
    ) SpokeRewardsV2Token(admin, bridgeRouter, hubChainId, hubContractAddress, addressOracle) {}

    function _sendToken(address recipient, uint256 amount) internal override {
        emit SendToken(recipient, amount);
    }
}
