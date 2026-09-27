`timescale 1ns/1ps
module tb;
  reg clk = 0;
  reg [3:0] sw = 0;
  wire [3:0] led;
  top dut(.clk(clk), .sw(sw), .led(led));
  always #5 clk = ~clk;
  initial begin
    sw = 4'h3;
    #20;
    if (led !== 4'h3) $fatal(1, "Unexpected led value");
    $display("VIVADO_TEST_PASS led=%h", led);
    #10 $finish;
  end
endmodule
