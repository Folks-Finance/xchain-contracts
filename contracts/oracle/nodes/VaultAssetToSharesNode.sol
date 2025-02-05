// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";

import "../interfaces/IExternalNode.sol";

contract VaultAssetToSharesNode is IExternalNode {
    using SafeCast for int256;

    IERC4626 public immutable tokenizedVaultStandard;

    constructor(address _tokenizedVaultStandard) {
        tokenizedVaultStandard = IERC4626(_tokenizedVaultStandard);
    }

    /// @notice Processes the parent node output to get the tokenized vault share price
    /// @return nodeOutput The output given by: price processed (standardized to parent d.p.), timestamp i.e. updatedAt from parent output response, node type.
    function process(
        NodeOutput.Data[] memory parentNodeOutputs,
        bytes memory
    ) external view returns (NodeOutput.Data memory) {
        /// @dev Fetch the vault exchange rate
        uint256 oneShare = 10 ** tokenizedVaultStandard.decimals();
        uint256 exchangeRate = tokenizedVaultStandard.convertToAssets(oneShare);
        /// @dev Convert the parent node output to the tokenized vault share price
        uint256 price = Math.mulDiv(parentNodeOutputs[0].price, exchangeRate, oneShare);

        return NodeOutput.Data(price, parentNodeOutputs[0].timestamp, NodeDefinition.NodeType.EXTERNAL, 0, 0);
    }

    function isValid(NodeDefinition.Data memory nodeDefinition) external view returns (bool) {
        if (
            nodeDefinition.nodeType != NodeDefinition.NodeType.EXTERNAL ||
            nodeDefinition.parents.length != 1 ||
            nodeDefinition.parameters.length != 32
        ) return false;

        /// @dev Check call tokenizedVaultStandard with no error
        uint256 oneShare = 10 ** tokenizedVaultStandard.decimals();
        tokenizedVaultStandard.convertToAssets(oneShare);

        return true;
    }

    function supportsInterface(bytes4 interfaceId) external pure override(IERC165) returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IExternalNode).interfaceId;
    }
}
