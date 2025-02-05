import { HDNodeWallet } from "ethers";
import { ethers } from "hardhat";
import { NodeManager, NodeManager__factory } from "../../../typechain-types";
import NodeType from "../assets/NodeType";

export const abi = ethers.AbiCoder.defaultAbiCoder();

export type NodeDefinitionData = [number, string, string[]];

export class NodeManagerUtil {
  public static buildNodeManager(nodeManagerAddress: string, wallet: HDNodeWallet): NodeManager {
    const nodeManagerFactory = new NodeManager__factory(wallet);
    const nodeManager: NodeManager = nodeManagerFactory.attach(nodeManagerAddress) as NodeManager;
    return nodeManager;
  }

  public static async registerNode(nodeManager: NodeManager, nodeDefinition: NodeDefinitionData): Promise<string> {
    const registerTxn = await nodeManager.registerNode(...nodeDefinition);
    await registerTxn.wait();
    const nodeId = await nodeManager.getNodeId(...nodeDefinition);
    return nodeId;
  }

  public static encodeChainlinkNodeDefinition(contract: string, twap: number): NodeDefinitionData {
    return [NodeType.CHAINLINK, abi.encode(["address", "uint256"], [contract, twap]), []];
  }

  public static encodePythNodeDefinition(contract: string, feedId: string, useEMA: boolean): NodeDefinitionData {
    return [NodeType.PYTH, abi.encode(["address", "bytes32", "bool"], [contract, feedId, useEMA]), []];
  }

  public static encodeStalenessCircuitBreakerNodeDefinition(
    staleness: number,
    parentIds: string[]
  ): NodeDefinitionData {
    return [NodeType.STALENESS_CIRCUIT_BREAKER, abi.encode(["uint256"], [staleness.toString()]), parentIds];
  }

  public static encodePriceDeviationCircuitBreakerNodeDefinition(
    deviation: number,
    parentIds: string[]
  ): NodeDefinitionData {
    return [NodeType.PRICE_DEVIATION_CIRCUIT_BREAKER, abi.encode(["uint256"], [deviation.toString()]), parentIds];
  }

  public static encodePriceDeviationSameOracleCircuitBreakerNodeDefinition(
    deviation: number,
    parentIds: string[]
  ): NodeDefinitionData {
    return [
      NodeType.PRICE_DEVIATION_SAME_ORACLE_CIRCUIT_BREAKER,
      abi.encode(["uint256"], [deviation.toString()]),
      parentIds,
    ];
  }

  public static encodeConstantNodeDefinition(constant: number | bigint): NodeDefinitionData {
    return [NodeType.CONSTANT, abi.encode(["uint256"], [constant.toString()]), []];
  }

  public static encodeExternalNodeDefinition(
    externalOracleAddress: string,
    parentNodes: string[] = []
  ): NodeDefinitionData {
    return [NodeType.EXTERNAL, abi.encode(["address"], [externalOracleAddress]), parentNodes];
  }
}
