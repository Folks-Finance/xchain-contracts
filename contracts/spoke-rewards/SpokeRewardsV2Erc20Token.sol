// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../bridge/interfaces/IBridgeRouter.sol";
import "../bridge/libraries/Messages.sol";
import "../spoke/interfaces/IAddressOracle.sol";
import "./SpokeRewardsV2Token.sol";

contract SpokeRewardsV2Erc20Token is SpokeRewardsV2Token {
    address public immutable token;

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        uint16 hubChainId,
        bytes32 hubContractAddress,
        IAddressOracle addressOracle,
        address token_
    ) SpokeRewardsV2Token(admin, bridgeRouter, hubChainId, hubContractAddress, addressOracle) {
        token = token_;
    }

    function fund(uint256 amount) external {
        // transfer tokens from sender to this spoke
        SafeERC20.safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
        emit Funded(amount);
    }

    function _sendToken(address recipient, uint256 amount) internal override {
        SafeERC20.safeTransfer(IERC20(token), recipient, amount);
    }
}
