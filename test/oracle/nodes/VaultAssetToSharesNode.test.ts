import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { NodeManagerUtil } from "../utils/nodeManagerUtils";
import { MockTokenizedVaultStandard, NodeManager, VaultAssetToSharesNode } from "../../../typechain-types";
import NodeType from "../assets/NodeType";
import { deployNodeManagerFixture } from "../bootstrap";
import { getOracleNodeId } from "../utils/utils";

describe("VaultAssetToSharesNode", async function () {
  let nodeManager: NodeManager;
  let mockTokenizedVaultStandard: MockTokenizedVaultStandard;
  let rate: number;
  let decimals: number;
  let constantNodeId: string;
  let constantPrice: bigint;

  beforeEach("Deploy NodeManager and MockTokenizedVaultStandard", async function () {
    ({ nodeManager } = await loadFixture(deployNodeManagerFixture));

    // Deploy MockTokenizedVaultStandard contract
    rate = 1_2345;
    decimals = 18;
    const MockTokenizedVaultStandard = await ethers.getContractFactory("MockTokenizedVaultStandard");
    mockTokenizedVaultStandard = await MockTokenizedVaultStandard.deploy(rate, decimals);
    await mockTokenizedVaultStandard.waitForDeployment();

    // Register constant node
    constantPrice = BigInt(1e18);
    const nodeDefinition = NodeManagerUtil.encodeConstantNodeDefinition(constantPrice);
    const registerTxn = await nodeManager.registerNode(...nodeDefinition);
    await registerTxn.wait();

    constantNodeId = await nodeManager.getNodeId(...nodeDefinition);
  });

  describe("ExternalNode with VaultAssetToSharesNode", async function () {
    let vaultAssetToSharesNode: VaultAssetToSharesNode;
    let vaultAssetToSharesNodeAddress: string;

    beforeEach("Deploy MockTokenizedVaultStandard contract", async function () {
      const mockTokenizedVaultStandardAddress = await mockTokenizedVaultStandard.getAddress();

      const VaultAssetToSharesNode = await ethers.getContractFactory("VaultAssetToSharesNode");
      vaultAssetToSharesNode = await VaultAssetToSharesNode.deploy(mockTokenizedVaultStandardAddress);
      await vaultAssetToSharesNode.waitForDeployment();
      vaultAssetToSharesNodeAddress = await vaultAssetToSharesNode.getAddress();
    });

    describe("Register node", async function () {
      it("Should register a vault share node", async function () {
        const parentNodes = [constantNodeId];

        const nodeDefinition = NodeManagerUtil.encodeExternalNodeDefinition(vaultAssetToSharesNodeAddress, parentNodes);
        const [nodeType, encodedNodeAddress, parents] = nodeDefinition;

        const registerTxn = await nodeManager.registerNode(...nodeDefinition);
        await registerTxn.wait();

        const nodeId = getOracleNodeId(...nodeDefinition);
        const node = await nodeManager.getNode(nodeId);

        expect(node.nodeType).to.equal(nodeType);
        expect(node.parameters).to.equal(encodedNodeAddress);
        expect(node.parents).to.deep.equal(parents);
      });

      it("Should emit InvalidNodeDefinition cause parameters length is not 32", async function () {
        const encodedNodeAddress = "0x00";

        const registerTxn = nodeManager.registerNode(NodeType.EXTERNAL, encodedNodeAddress, []);

        await expect(registerTxn).to.revertedWithCustomError(nodeManager, "InvalidNodeDefinition");
      });

      it("Should emit InvalidNodeDefinition cause has no parent", async function () {
        const nodeDefinition = NodeManagerUtil.encodeExternalNodeDefinition(vaultAssetToSharesNodeAddress, []);

        const registerTxn = nodeManager.registerNode(...nodeDefinition);

        await expect(registerTxn).to.revertedWithCustomError(nodeManager, "InvalidNodeDefinition");
      });

      it("Should emit InvalidNodeDefinition cause tokenizedVaultStandard call revert", async function () {
        await mockTokenizedVaultStandard.setRate(0);

        const parentNodes = [constantNodeId];
        const nodeDefinition = NodeManagerUtil.encodeExternalNodeDefinition(vaultAssetToSharesNodeAddress, parentNodes);

        const registerTxn = nodeManager.registerNode(...nodeDefinition);

        await expect(registerTxn).to.revertedWith("Rate is 0");
      });
    });

    describe("Contract methods", async function () {
      let nodeId: string;

      beforeEach("Register vault share node", async function () {
        const parentNodes = [constantNodeId];
        const nodeDefinition = NodeManagerUtil.encodeExternalNodeDefinition(vaultAssetToSharesNodeAddress, parentNodes);

        const registerTxn = await nodeManager.registerNode(...nodeDefinition);
        await registerTxn.wait();

        nodeId = getOracleNodeId(...nodeDefinition);
      });

      it("Should process correctly", async function () {
        const nodeOutput = await nodeManager.process(nodeId);
        const block = await ethers.provider.getBlock("latest");
        expect(nodeOutput.price).to.equal((constantPrice * BigInt(rate)) / BigInt(1e4));
        expect(nodeOutput.timestamp).to.equal(block?.timestamp);
      });
    });
  });
});
