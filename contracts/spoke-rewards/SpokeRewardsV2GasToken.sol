// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../bridge/interfaces/IBridgeRouter.sol";
import "../bridge/libraries/Messages.sol";
import "../spoke/interfaces/IAddressOracle.sol";
import "./SpokeRewardsV2Token.sol";

contract SpokeRewardsV2GasToken is SpokeRewardsV2Token {
    error IncorrectAmountReceived(uint256 expected, uint256 actual);
    error FailedToSendToken(address recipient, uint256 amount);

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        uint16 hubChainId,
        bytes32 hubContractAddress,
        IAddressOracle addressOracle
    ) SpokeRewardsV2Token(admin, bridgeRouter, hubChainId, hubContractAddress, addressOracle) {}

    function fund() external payable {
        emit Funded(msg.value);
    }

    function _sendToken(address recipient, uint256 amount) internal override {
        (bool sent, ) = recipient.call{ value: amount }("");
        if (!sent) revert FailedToSendToken(recipient, amount);
    }
}
