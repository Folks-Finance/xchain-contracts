// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract MockTokenizedVaultStandard is IERC4626 {
    uint256 public constant RATE_SCALE_FACTOR = 1e4;
    uint256 public rate;
    uint8 public decimals;

    constructor(uint256 _rate, uint8 _decimals) {
        rate = _rate;
        decimals = _decimals;
    }

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function setDecimals(uint8 _decimals) external {
        decimals = _decimals;
    }

    function convertToAssets(uint256 shares) external view override returns (uint256) {
        if (rate == 0) revert("Rate is 0");
        return Math.mulDiv(shares, rate, RATE_SCALE_FACTOR);
    }

    function asset() external pure override returns (address) {
        revert("Not implemented");
    }

    function totalAssets() external pure override returns (uint256) {
        revert("Not implemented");
    }

    function convertToShares(uint256) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function maxDeposit(address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function previewDeposit(uint256) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function deposit(uint256, address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function maxMint(address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function previewMint(uint256) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function mint(uint256, address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function maxWithdraw(address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function previewWithdraw(uint256) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function withdraw(uint256, address, address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function maxRedeem(address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function previewRedeem(uint256) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function redeem(uint256, address, address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function totalSupply() external pure override returns (uint256) {
        revert("Not implemented");
    }

    function balanceOf(address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function transfer(address, uint256) external pure override returns (bool) {
        revert("Not implemented");
    }

    function allowance(address, address) external pure override returns (uint256) {
        revert("Not implemented");
    }

    function approve(address, uint256) external pure override returns (bool) {
        revert("Not implemented");
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        revert("Not implemented");
    }

    function name() external pure override returns (string memory) {
        revert("Not implemented");
    }

    function symbol() external pure override returns (string memory) {
        revert("Not implemented");
    }
}
